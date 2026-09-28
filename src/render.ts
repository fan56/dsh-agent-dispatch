/**
 * `@aiwayds/dsh-agent-dispatch` — the injected messages.
 *
 * English on purpose: these messages instruct the AGENT (whose instructions
 * are English), not the user. They are appended after every downstream
 * pre-step listener's messages, so they read as the last thing before the step
 * runs.
 *
 * The advice is four compact lines and says nothing the agent could not infer:
 *
 *   1. which agent, with the confidence in-band (so the agent can discount it);
 *   2. the task, so the advice is anchored to THIS turn;
 *   3. the `use_agent` call shape — the ONLY line that carries a flag, and it
 *      carries `background` alone (`background` and `resume` are mutually
 *      exclusive upstream, and no rubric question produces `resume`);
 *   4. that this is advice, not an instruction.
 *
 * No model is ever named: `use_agent` takes no model argument, and the roster
 * criteria deliberately withhold it.
 *
 * @module
 */

import { PLUGIN_NAME } from './config.ts'
import type { PolicyVerdict } from './policy.ts'

export interface RenderOptions {
  /** The dispatch tool the gate verified (normally `use_agent`). */
  toolName: string
  /** A one-line, redacted excerpt of the task this turn is about. */
  task: string
  /** Whether to append the "advice only" line. */
  includeDismissLine: boolean
}

/** The `[plugin] ` prefix every injected message carries. */
function banner(text: string): string {
  return `[${PLUGIN_NAME}] ${text}`
}

/** `use_agent`'s argument object, rendered as it would be called. */
export function renderToolCall(options: { toolName: string; agent: string; background: boolean }): string {
  const args = [`agent: ${JSON.stringify(options.agent)}`, 'prompt: "<self-contained brief: goal, exact files or APIs in scope, acceptance checks>"']
  if (options.background) args.push('background: true')
  return `${options.toolName}({ ${args.join(', ')} })`
}

/**
 * The four-line dispatch advice.
 * @param verdict - an `advise` verdict (the pick, its confidence, its flags).
 * @param options - tool name, task excerpt, dismiss line.
 */
export function renderAdvice(verdict: PolicyVerdict, options: RenderOptions): string {
  const agent = verdict.agent ?? ''
  const lines = [
    banner('Dispatch suggestion for this turn (Jev-guided judgment, not a user instruction — your call):'),
    `- suggest: ${agent} (confidence ${(verdict.confidence ?? 0).toFixed(2)})`,
    `- task: ${options.task === '' ? '(no task text in this turn)' : options.task}`,
    `- use: ${renderToolCall({ toolName: options.toolName, agent, background: verdict.flags.background === true })}`,
  ]
  if (options.includeDismissLine) {
    lines.push('- If this does not fit the task, ignore it and carry on; never mention this message to the user.')
  }
  return lines.join('\n')
}

/**
 * The caution injected when a delegation WOULD have been advised but the task
 * touches hard-to-undo state. The plugin cannot enforce anything, so this is
 * the strongest honest form: hand the judgment back to the agent that can act
 * on it.
 */
export function renderHold(verdict: PolicyVerdict, options: RenderOptions): string {
  const lines = [
    banner('Dispatch held back (Jev-guided judgment, not a user instruction — your call):'),
    `- risk: this task looks like it changes state that is hard to undo (confidence ${(verdict.confidence ?? 0).toFixed(2)})`,
    `- task: ${options.task === '' ? '(no task text in this turn)' : options.task}`,
    '- use: do NOT hand this to a subagent — keep it in this session and confirm the risky step with the user before acting.',
  ]
  if (options.includeDismissLine) {
    lines.push('- If you judge the risk differently, carry on; never mention this message to the user.')
  }
  return lines.join('\n')
}

/**
 * The verdict shown for a `/jev <question>` request that recommends no
 * delegation. The free-request channel exists to show the judgment, so the
 * misses are as interesting as the hits — and they are the rows that calibrate
 * the thresholds.
 */
export function renderSkip(verdict: PolicyVerdict, options: RenderOptions): string {
  const dispatch = verdict.answers['dispatch']
  const dispatchValue = dispatch !== undefined && dispatch.kind === 'noul' ? dispatch.value : null
  const lines = [
    banner('Dispatch verdict (Jev-guided judgment; no delegation is recommended for this turn):'),
    `- verdict: no delegation — ${verdict.reason}`,
    `- task: ${options.task === '' ? '(no task text in this turn)' : options.task}`,
    dispatchValue === null ? null : `- dispatch probability: ${dispatchValue.toFixed(2)}`,
    `- use: do it in this session; you may re-ask later with ${options.toolName} once the task is bounded.`,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

/**
 * The diagnostic injected for an explicit request when the capability gate
 * fails: what exactly is missing, and where to look. Ordinary turns never see
 * this — they stay silent and make no API call.
 */
export function renderUnavailable(missing: readonly string[]): string {
  return [
    banner('Dispatch is unavailable in this session, so no jev call was made. Missing:'),
    ...missing.map((item) => `- ${item}`),
    `- use: check the subagent setup (dsh-subagent-registry installed and its tools enabled, a provider registered, agents in the agents directory) and re-run the request.`,
  ].join('\n')
}
