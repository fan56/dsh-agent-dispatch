/**
 * `@aiwayds/dsh-agent-dispatch` — the plugin host half.
 *
 * Joins the `agent/pre-step` waterfall with `prepend: true`, awaits the
 * downstream decision, and — for turns that explicitly asked for a verdict
 * (`/dispatch <task>`, `/jev <question>`) — asks TypeSafe Jev, in ONE request,
 * whether the task belongs to a registered agent and which one. When the
 * verdict clears the calibrated thresholds, a four-line source-attributed
 * message is APPENDED after every other message of the step, so the advice
 * sits where the agent reads it last.
 *
 * Under `mode: 'auto'` the same path serves ordinary turns, but only after a
 * LOCAL keyword gate clears: a plain turn whose text hits an `autoKeywords`
 * entry is worth a verdict, and one that hits nothing is returned untouched in
 * silence — no call, no injection, no log line. Explicit triggers are matched
 * first and are never gated, so `/jev` and `/dispatch` keep their semantics
 * (rendered skip, capability diagnostic) in every mode. The gate's silent half
 * is also why `auto` wants a `logDir`: the verdict log is the only place the
 * cost of a keyword hit becomes visible.
 *
 * The plugin owns no delegation machinery. It names an agent and the shape of
 * the `use_agent` call; `use_agent` (dsh-subagent-registry) does the spawning,
 * and the capability gate re-probes its live visibility on every request
 * because installing this plugin implies nothing about the subagent stack.
 *
 * Fail-open is total and quiet. A rejected step is returned untouched, an
 * aborted turn injects nothing, a missing key means the plugin never even
 * registers its listener, a jev failure passes the turn through and lands in
 * the verdict log, and no path emits a warning: degradation here is silence,
 * because a wrong dispatch suggestion is worse than no suggestion. The only
 * line a missing jev ever costs is a single `info` at boot.
 *
 * @module
 */

import { classify, isConfigured, type JevAnswers, type JevQuestions } from '@aiwayds/dsh-jev-core'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: importing the host package is what brings the `agent/pre-step`
// event declaration into this program, so the waterfall signature below is the
// host's own contract rather than a local guess. Erased at runtime.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KeySources } from '@aiwayds/dsh-jev-core'
import { loggingEnabled, PLUGIN_NAME, PLUGIN_SOURCE_KIND, resolveConfig, type DispatchConfig } from './config.ts'
import { checkDispatchCapabilities, isSubagentSession, type CapabilityServices, type DispatchAgentLike } from './capabilities.ts'
import { appendVerdict, verdictId, type LoggerLike, type VerdictRecord } from './log.ts'
import { failed, decide, type PolicyVerdict } from './policy.ts'
import { buildState, taskExcerpt, type DispatchMessage } from './redact.ts'
import { agentOptions, buildQuestions, findKeyword, findTrigger, resolvePick, type KeywordHit, type Trigger } from './rubric.ts'
import { loadRoster, resolveAgentsDir, type Roster } from './roster.ts'
import { renderAdvice, renderHold, renderSkip, renderUnavailable } from './render.ts'

/**
 * Test seams. Every one of them exists because the thing it replaces is either
 * unobservable from a test (host services) or must never be reached in one
 * (the network, the keychain, a bare checkout with no dsh closure).
 */
export interface DispatchDeps {
  /** Host services, resolved at request time. Defaults to `ctx.get(...)`. */
  services?: CapabilityServices
  /** Message factory. Defaults to the pinned peer's `createUserMessage`. */
  messageBuilder?: (content: string) => Promise<DispatchMessage | null>
  /** Injectable fetch; passed straight through to the core client. */
  fetch?: typeof fetch
  /** Environment for key and dsh-home resolution. */
  env?: NodeJS.ProcessEnv
  /** Injectable keychain runner (tests pass one that always misses). */
  keychainRunner?: KeySources['keychainRunner']
  /** Explicit key override (wins over env and keychain, like the core). */
  apiKey?: string
}

/** The pre-step waterfall decision, structurally typed. */
interface PreStepDecision {
  kind: string
  messages?: readonly DispatchMessage[]
}

export const name = PLUGIN_NAME

/**
 * Build a DSH user message through the pinned peer (`@deepseek-ai/dsh-llm`),
 * which owns message invariants including identity. The specifier is held in a
 * variable on purpose: the peer is absent from a bare checkout (and absent from
 * the public registry), so the import is a RUNTIME capability probe, not a
 * compile-time dependency — the type graph must not require a package this
 * repo may not install. Returns null when the peer is unreachable; the caller
 * then SKIPS the injection rather than fabricating a message that might
 * violate the session's format contract.
 */
async function pluginMessage(content: string): Promise<DispatchMessage | null> {
  try {
    const specifier = '@deepseek-ai/dsh-llm'
    const mod = await import(specifier) as { createUserMessage?: (input: unknown) => unknown }
    if (typeof mod.createUserMessage !== 'function') return null
    return mod.createUserMessage({
      content: [{ type: 'text', text: content }],
      // Merge-extensible source union: this plugin declares its own kind and
      // consumers fall through unknown ones.
      source: { kind: PLUGIN_SOURCE_KIND, plugin: PLUGIN_NAME },
    }) as DispatchMessage
  } catch {
    return null
  }
}

/** Frontmatter `deep` per agent name — the depth budget a pick must fit. */
function deepByAgent(roster: Roster): Record<string, number> {
  const out: Record<string, number> = {}
  for (const agent of roster.agents) out[agent.meta.name] = agent.meta.deep
  return out
}

/** Whether the turn's cancellation signal has fired (read through a call so the
 *  narrowing from an earlier check does not make the later re-check a
 *  tautology — a turn CAN be cancelled while the jev call is in flight). */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Cordis plugin entry.
 * @param ctx - the host context.
 * @param input - the `dsh-agent-dispatch` row's `config`.
 * @param deps - dependency overrides for tests.
 */
export function apply(ctx: Context, input: unknown = {}, deps: DispatchDeps = {}): void {
  const logger: LoggerLike = ctx.logger as unknown as LoggerLike
  let config: DispatchConfig
  try {
    config = resolveConfig(input)
  } catch (error) {
    // A broken config must be loud but must not take the host down: keep the
    // plugin inert and report on every boot.
    logger.error?.(`${PLUGIN_NAME}: ${String(error)}`)
    return
  }

  if (config.mode === 'off') {
    // Opt-in starting point: register nothing, share nothing, cost nothing.
    logger.info?.(`${PLUGIN_NAME}: mode off; not listening`)
    return
  }

  const env = deps.env ?? process.env
  const keySources: KeySources = {
    env,
    ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}),
    ...(deps.keychainRunner !== undefined ? { keychainRunner: deps.keychainRunner } : {}),
  }
  if (!isConfigured(keySources)) {
    // jev-optional leg #1: no key configured. Silent for the whole session —
    // one info at boot, no listener registered, zero runtime output. Same
    // behavior as `mode: off`, which is the point: unconfigured == off.
    logger.info?.(`${PLUGIN_NAME}: no jev key configured (keychain, TYPESAFE_API_KEY, or JEV_API_KEY); dispatch stays silent`)
    return
  }

  const buildMessage = deps.messageBuilder ?? pluginMessage
  const logDir = loggingEnabled(config) ? config.logDir : null
  const auto = config.mode === 'auto'
  if (auto && logDir === null) {
    // The gate's misses are invisible BY DESIGN (zero calls, zero lines), so
    // the verdict log is the only channel that says which keywords earn their
    // call. Without it, `auto` runs uncalibrated — say so once at boot rather
    // than letting the user discover it by feel.
    logger.info?.(`${PLUGIN_NAME}: mode auto without logDir — which autoKeywords hits are worth a jev call cannot be calibrated without the verdict log; set logDir to record them`)
  }
  let warnedNoFactory = false

  // prepend: this listener runs after the downstream listeners have produced
  // their decision, so it sees the final claimed batch and appends its
  // message last — the same etiquette the memory plugins use, so the dispatch
  // advice sits below recall context in the turn.
  ctx.on('agent/pre-step', async (payload: { agent?: Agent; signal?: AbortSignal }, next: () => Promise<PreStepDecision | undefined>) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || aborted(payload.signal)) return decision as never
      const agent = payload.agent as DispatchAgentLike | undefined
      // A subagent's own turn never gets dispatch advice: it cannot usefully
      // delegate further in this deployment, and advice-into-advice recursion
      // is noise at best.
      if (config.skipSubagentSessions && isSubagentSession(agent)) return decision as never

      // Explicit triggers are matched first and are never gated: `/dispatch`
      // and `/jev` mean the same thing in every mode.
      const trigger = findTrigger(decision.messages, config.triggers)
      // mode "once": only turns that explicitly ask get classified — one call
      // per request, everything else passes through untouched (no call, no
      // data sharing, no log line). mode "auto": an ordinary turn has to clear
      // the local keyword gate first, and a miss is the SAME untouched return —
      // that is the whole difference between `auto` and asking about every turn.
      const keyword = trigger === null && auto ? findKeyword(decision.messages, config.autoKeywords) : null
      if (trigger === null && keyword === null) return decision as never

      // jev-optional leg #2: the key was there at boot and is gone now.
      if (!isConfigured(keySources)) return decision as never

      const cwd = agent?.cwd ?? process.cwd()
      const roster = await loadRoster(resolveAgentsDir(config.agentsDir, env))
      const services = deps.services ?? {
        tools: ctx.get('tools') as CapabilityServices['tools'],
        subagents: ctx.get('subagents') as CapabilityServices['subagents'],
      }
      const capabilities = checkDispatchCapabilities(services, agent, config, roster)
      if (!capabilities.ok) {
        // An auto turn arrived here through the local gate and never asked for
        // a verdict, so a gap in the subagent stack is not its business: it
        // stays completely silent — no diagnostic, no info line, no log row.
        // Every explicit turn, by contrast, DID ask, so it gets the diagnostic
        // naming exactly what is missing.
        if (trigger === null) return decision as never
        const reason = capabilities.missing.join('; ')
        if (logDir !== null) {
          await appendVerdict(logDir, verdictRecord({
            config, agent, trigger, keyword,
            verdict: failed('unavailable', reason),
            latencyMs: null,
          }), logger)
        }
        logger.info?.(`${PLUGIN_NAME}: dispatch unavailable — ${reason}`)
        const diagnostic = await buildMessage(renderUnavailable(capabilities.missing))
        if (diagnostic === null) return decision as never
        return { ...decision, messages: [...(decision.messages ?? []), diagnostic] } as never
      }

      const state = buildState(decision.messages, cwd, config.stateChars, config.redactPatterns, trigger?.task ?? '')
      if (state === '') return decision as never // nothing user-authored to judge

      const options = agentOptions(roster)
      const questions: JevQuestions = buildQuestions(options.criteria)
      let verdict: PolicyVerdict
      let latencyMs: number | null = null
      try {
        const result = await classify({
          questions,
          state,
          timeoutMs: config.timeoutMs,
          ...(config.model !== null ? { model: config.model } : {}),
          ...(payload.signal !== undefined ? { signal: payload.signal } : {}),
          ...(deps.fetch !== undefined ? { fetchImpl: deps.fetch } : {}),
          ...keySources,
        })
        verdict = decide(result, {
          thresholds: config.thresholds,
          capabilities,
          deepByAgent: deepByAgent(roster),
        })
        // The pick arrives as a rubric option label (`workhorse (牛马狗)`);
        // `use_agent` takes the agent id. An option this request never offered
        // is not translated, and the verdict is dropped rather than guessed at.
        if (verdict.agent !== null) {
          const agent = resolvePick(verdict.agent, options)
          if (agent === null) {
            verdict = { ...verdict, action: 'skip', reason: `unknown agent option "${verdict.agent}"`, agent: null }
          } else {
            verdict = { ...verdict, agent }
          }
        }
        latencyMs = result.latencyMs
      } catch (error) {
        // Fail-open: a timeout, a 429, an invalid response — the turn proceeds
        // undispatched and the reason lands in the log. Typed Jev errors carry
        // a stable `code`; the message keeps the human detail.
        verdict = failed('error', error instanceof Error ? error.message : String(error))
      }

      // The turn may have been cancelled while the call was in flight; a
      // message nobody will read is worse than none.
      if (aborted(payload.signal)) return decision as never

      const excerpt = taskExcerpt(decision.messages, trigger?.task ?? '', config.redactPatterns)
      const renderOptions = { toolName: config.toolName, task: excerpt, includeDismissLine: config.includeDismissLine }
      let addition: DispatchMessage | null = null
      if (verdict.action === 'advise') {
        addition = await buildMessage(renderAdvice(verdict, renderOptions))
        logger.info?.(`${PLUGIN_NAME}: recommend → ${verdict.agent} (confidence ${(verdict.confidence ?? 0).toFixed(2)})`)
      } else if (verdict.action === 'hold') {
        addition = await buildMessage(renderHold(verdict, renderOptions))
        logger.info?.(`${PLUGIN_NAME}: hold — ${verdict.reason}`)
      } else if (verdict.action === 'skip' && trigger?.kind === 'jev') {
        // `/jev` is the free decision request: its verdict is the answer, so a
        // miss is rendered too. `/dispatch` only wants the recommendation, and
        // an auto turn (trigger null) never wanted the verdict at all.
        addition = await buildMessage(renderSkip(verdict, renderOptions))
      }
      if (addition === null && (verdict.action === 'advise' || verdict.action === 'hold') && !warnedNoFactory) {
        warnedNoFactory = true
        logger.warn?.(`${PLUGIN_NAME}: @deepseek-ai/dsh-llm is unavailable; skipping injection instead of fabricating a message`)
      }

      if (logDir !== null) {
        // Built AFTER the render decision on purpose: `action` is what jev
        // decided, `delivered` is whether the recommendation actually reached
        // the turn. The two are different facts.
        await appendVerdict(logDir, verdictRecord({
          config, agent, trigger, keyword, verdict, latencyMs,
          ...(verdict.action === 'advise' || verdict.action === 'hold' ? { delivered: addition !== null } : {}),
        }), logger)
      }

      if (addition !== null) {
        return { ...decision, messages: [...(decision.messages ?? []), addition] } as never
      }
      // An auto turn's skip is silent: it never asked for a verdict, so the
      // "skip —" line would be commentary on a question nobody posed. The
      // verdict log still records it (above), which is where it belongs.
      if (verdict.action === 'skip' && trigger !== null) logger.info?.(`${PLUGIN_NAME}: skip — ${verdict.reason}`)
      return decision as never
    } catch (error) {
      // Last line of defence: a bug here is still just a turn that proceeds
      // without advice.
      logger.warn?.(`${PLUGIN_NAME}: unexpected failure, turn proceeds without advice — ${String(error)}`)
      return decision as never
    }
  }, { prepend: true })
}

/**
 * Assemble one NDJSON row. Answers are kept whole: the log is the calibrator.
 * `trigger` is the explicit trigger word (`/dispatch`) or the local gate's
 * `kw:<keyword>` label for a keyword-hit auto turn — the log has to be able to
 * answer "which keyword's hits were worth a call", so the two are distinguishable.
 */
function verdictRecord(input: {
  config: DispatchConfig
  agent?: DispatchAgentLike
  trigger: Trigger | null
  keyword: KeywordHit | null
  verdict: PolicyVerdict
  latencyMs: number | null
  delivered?: boolean
}): VerdictRecord {
  return {
    at: new Date().toISOString(),
    id: verdictId(),
    session: input.agent?.session?.id ?? null,
    mode: input.config.mode,
    trigger: input.trigger?.trigger ?? (input.keyword === null ? null : `kw:${input.keyword.keyword}`),
    action: input.verdict.action,
    reason: input.verdict.reason,
    confidence: input.verdict.confidence,
    route: input.verdict.agent,
    usage: input.verdict.usage,
    latencyMs: input.latencyMs,
    answers: input.verdict.answers as JevAnswers,
    ...(input.delivered !== undefined ? { delivered: input.delivered } : {}),
  }
}

export default apply

export * from './config.ts'
export * from './roster.ts'
export * from './redact.ts'
export * from './capabilities.ts'
export * from './rubric.ts'
export * from './policy.ts'
export * from './render.ts'
export * from './log.ts'
