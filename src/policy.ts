/**
 * `@aiwayds/dsh-jev-dispatch` — the policy.
 *
 * A pure function over one strictly-validated answer set: what the plugin
 * should do with this turn. No host, no network, no key — which is what makes
 * the calibration surface testable and what lets every threshold in
 * `config.thresholds` be read in exactly one place.
 *
 * The four calibrated decisions, in evaluation order:
 *
 *   1. `dispatch` band. ≥ recommend → continue; ≤ skip → skip; between the two
 *      is UNCERTAINTY, not weak evidence, and skips (the rubric ticket's third
 *      dry-run: "implement the plan we just discussed" is a re-brief, not a
 *      delegation).
 *   2. `risky` veto, checked only on a would-be delegation. A task that touches
 *      hard-to-undo state is HELD: the plugin says "do not hand this off" rather
 *      than dropping the topic, because the judgment it just paid for is the
 *      useful part. A turn that needs no delegation anyway still skips.
 *   3. `agent` pick, gated on confidence AND the top1−top2 margin over the
 *      AGENT options (`none` is an abstention, not a rival candidate). A tie is
 *      noise — the second dry-run, "look at this screenshot and tell me what
 *      the error is": two agents look equally good, so no agent is named.
 *   4. the per-agent depth refinement, then the `long_running` flag.
 *
 * Missing or non-numeric answers skip rather than default. An absent judgment
 * is never positive evidence.
 *
 * @module
 */

import type { JevAnswers, JevUsage } from '@aiwayds/dsh-jev-core'
import type { Thresholds } from './config.ts'
import { depthConflict, type CapabilityReport } from './capabilities.ts'
import { NO_AGENT } from './rubric.ts'

/**
 * What the plugin does with the turn:
 *
 * - `advise` — inject a four-line recommendation;
 * - `hold` — inject the "do not delegate this" caution (risky);
 * - `skip` — nothing is injected (the log still records why);
 * - `unavailable` — the capability gate blocked it (only explicit requests see
 *   a diagnostic);
 * - `error` — the jev call failed; the turn passes through untouched.
 */
export type DispatchAction = 'advise' | 'hold' | 'skip' | 'unavailable' | 'error'

/** Flags the advice may carry. Only `background` exists in v1 — see below. */
export interface AdviceFlags {
  /**
   * Dispatch the child in the background (`use_agent` returns its id
   * immediately). It is mutually exclusive with `resume`, which no rubric
   * question produces — so v1 can never emit the one combination `use_agent`
   * rejects.
   */
  background?: true
}

export interface PolicyVerdict {
  action: DispatchAction
  reason: string
  /** Confidence of the decisive answer (the `agent` pick), when there is one. */
  confidence: number | null
  /** The recommended agent name, or null. Never a model — see roster.ts. */
  agent: string | null
  flags: AdviceFlags
  answers: JevAnswers
  model: string
  usage: JevUsage | null
  latencyMs: number
}

/** The classified result, as returned by `@aiwayds/dsh-jev-core`. */
export interface ClassifyResult {
  answers: JevAnswers
  model: string
  usage: JevUsage | null
  latencyMs: number
}

/** What the policy needs beyond the answers: the calibration and the pick inputs. */
export interface PolicyContext {
  thresholds: Thresholds
  /** The gate report for this request, for the per-agent depth refinement. */
  capabilities?: Pick<CapabilityReport, 'sessionDepth' | 'maxDepth'> | null
  /** Frontmatter `deep` per agent name, for the same refinement. */
  deepByAgent?: Readonly<Record<string, number>> | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function noulValue(answers: JevAnswers, id: string): number | null {
  const answer = answers[id]
  return answer !== undefined && answer.kind === 'noul' ? finite(answer.value) : null
}

/** The top-two probabilities over the AGENT options, best first. */
function agentMargin(answers: JevAnswers): number | null {
  const answer = answers['agent']
  if (answer === undefined || answer.kind !== 'choice' || answer.probabilities === null) return null
  const scores = Object.entries(answer.probabilities)
    .filter(([name]) => name !== NO_AGENT)
    .map(([, probability]) => finite(probability) ?? 0)
    .sort((a, b) => b - a)
  if (scores.length === 0) return null
  const top = scores[0] as number
  const second = scores[1] ?? 0
  return top - second
}

/** A verdict that recommends nothing, carrying the answers for the log. */
function skip(reason: string, result: ClassifyResult, confidence: number | null = null): PolicyVerdict {
  return {
    action: 'skip',
    reason,
    confidence,
    agent: null,
    flags: {},
    answers: result.answers,
    model: result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
  }
}

/**
 * Decide what to do with one classified turn. Pure: the same answers and
 * context always produce the same verdict.
 * @param result - the strictly-validated classify result.
 * @param context - thresholds plus the depth inputs for the picked agent.
 */
export function decide(result: ClassifyResult, context: PolicyContext): PolicyVerdict {
  const { thresholds } = context
  const answers = result.answers

  // 1. Should this be delegated at all?
  const dispatch = noulValue(answers, 'dispatch')
  if (dispatch === null) return skip('dispatch answer missing', result)
  if (dispatch <= thresholds.dispatchSkip) {
    return skip(`dispatch ${dispatch.toFixed(2)} <= ${thresholds.dispatchSkip} (do it here)`, result, dispatch)
  }
  if (dispatch < thresholds.dispatchRecommend) {
    return skip(`dispatch ${dispatch.toFixed(2)} is uncertain (< ${thresholds.dispatchRecommend})`, result, dispatch)
  }

  const base: Omit<PolicyVerdict, 'action' | 'reason' | 'agent' | 'flags'> = {
    confidence: null,
    answers,
    model: result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
  }

  // 2. Hard-to-undo state vetoes the delegation (only reached on a yes).
  const risky = noulValue(answers, 'risky')
  if (risky !== null && risky >= thresholds.risky) {
    return {
      ...base,
      action: 'hold',
      reason: `risky ${risky.toFixed(2)} >= ${thresholds.risky} (kept in this session)`,
      confidence: dispatch,
      agent: null,
      flags: {},
    }
  }

  // 3. Who takes it.
  const answer = answers['agent']
  if (answer === undefined || answer.kind !== 'choice') return skip('agent answer missing', result, dispatch)
  const pick = answer.value
  if (pick === NO_AGENT) return skip('jev declined to name an agent (none)', result, dispatch)
  const confidence = finite(answer.confidence)
  if (confidence === null || confidence < thresholds.agentConfidence) {
    return skip(`agent confidence ${confidence === null ? 'n/a' : confidence.toFixed(2)} < ${thresholds.agentConfidence}`, result, confidence)
  }
  const margin = agentMargin(answers)
  if (margin === null) return skip('agent probabilities missing (no margin to check)', result, confidence)
  if (margin < thresholds.agentMargin) {
    return skip(`agent margin ${margin.toFixed(2)} < ${thresholds.agentMargin} (top two look alike)`, result, confidence)
  }

  // 4a. The pick must still fit the delegation depth budget.
  const deep = context.deepByAgent?.[pick]
  const capabilities = context.capabilities
  if (capabilities !== null && capabilities !== undefined && deep !== undefined) {
    const conflict = depthConflict({ ok: true, missing: [], ...capabilities }, deep)
    if (conflict !== null) return skip(`depth: ${conflict}`, result, confidence)
  }

  // 4b. Long work runs in the background.
  const longRunning = noulValue(answers, 'long_running')
  const flags: AdviceFlags = longRunning !== null && longRunning >= thresholds.longRunning ? { background: true } : {}

  return {
    ...base,
    action: 'advise',
    reason: `dispatch ${dispatch.toFixed(2)}, ${pick} at ${confidence.toFixed(2)} (margin ${margin.toFixed(2)})`,
    confidence,
    agent: pick,
    flags,
  }
}

/**
 * The verdict for a turn the plugin never got to judge: no key, a broken
 * question set, a failed call. Kept in the same shape so the log writer has
 * one code path.
 */
export function failed(action: Extract<DispatchAction, 'error' | 'unavailable'>, reason: string): PolicyVerdict {
  return {
    action,
    reason,
    confidence: null,
    agent: null,
    flags: {},
    answers: {},
    model: '',
    usage: null,
    latencyMs: 0,
  }
}
