/**
 * `@aiwayds/dsh-jev-dispatch` — the rubric and the turn triggers.
 *
 * Four atomic questions in ONE request (the wire contract bills and waits once):
 *
 *   dispatch      noul   should this turn be delegated at all?
 *   agent         choice which registered agent — plus an explicit `none` abstention
 *   risky         noul   does it change state that is hard to undo?
 *   long_running  noul   should it run in the background?
 *
 * The `agent` criteria are the roster itself, built fresh per request by
 * `roster.ts`. Two rubric decisions worth stating, because both were decided
 * against the obvious alternative:
 *
 * - There is no effort/blast-radius score question. The community sibling asks;
 *   under an agent axis it has no consumer (cost is fixed by frontmatter) and
 *   it dilutes the batch.
 * - `none` is a real option, not a fallback string: without it the model must
 *   always name somebody, and a forced pick is exactly the false advice this
 *   plugin's silence-is-degradation rule exists to avoid.
 *
 * @module
 */

import type { JevQuestions } from '@aiwayds/dsh-jev-core'
import type { DispatchMessage } from './redact.ts'
import { isPlainUserMessage, messageText } from './redact.ts'
import { criteriaEntry, type Roster } from './roster.ts'

/** The `none` option appended to the `agent` choice, and the sentinel for it. */
export const NO_AGENT = 'none'

/**
 * What an explicit trigger is asking for. Both are evaluated by the same
 * rubric; they differ only in what the user gets back when the verdict is a
 * skip — `/dispatch` wants the recommendation, `/jev` wants the judgment.
 */
export type TriggerKind = 'dispatch' | 'jev'

export interface Trigger {
  kind: TriggerKind
  /** The text after the trigger word; may be empty (`/jev` on its own). */
  task: string
  /** The trigger token that matched, for the log. */
  trigger: string
}

/** The question ids this rubric asks, in the order they are logged. */
export const QUESTION_IDS = ['dispatch', 'agent', 'risky', 'long_running'] as const

export type QuestionId = (typeof QUESTION_IDS)[number]

/**
 * Classify a trigger word into a trigger kind. Everything that is not
 * `/dispatch` is a free decision request — the two triggers differ in intent,
 * not in rubric, so an added custom trigger gets the more general semantics.
 */
function kindOf(trigger: string): TriggerKind {
  return trigger === '/dispatch' ? 'dispatch' : 'jev'
}

/**
 * Find an explicit trigger in the turn's user messages. Returns null when no
 * PLAIN user turn starts with a configured trigger — the caller then leaves the
 * turn completely untouched (no call, no data sharing, no log line).
 *
 * Word boundary: `/jev` must not fire on `/jevis`, and a trigger followed by
 * nothing but punctuation is still a trigger.
 * @param messages - the claimed messages for this step.
 * @param triggers - the configured trigger words.
 */
export function findTrigger(
  messages: readonly DispatchMessage[] | null | undefined,
  triggers: readonly string[],
): Trigger | null {
  for (const message of messages ?? []) {
    if (!isPlainUserMessage(message)) continue
    const text = messageText(message).trim()
    if (text.length === 0) continue
    for (const trigger of triggers ?? []) {
      if (typeof trigger !== 'string' || trigger === '') continue
      if (!text.toLowerCase().startsWith(trigger.toLowerCase())) continue
      const after = text[trigger.length]
      if (after !== undefined && /[A-Za-z0-9_-]/.test(after)) continue
      return { kind: kindOf(trigger), task: text.slice(trigger.length).trim(), trigger }
    }
  }
  return null
}

/**
 * Build the wire question set for one request.
 * @param criteria - the `agent` choice options, from `roster.criteriaLines()`
 *   (the roster lines PLUS the `none` option, keyed by option name).
 */
export function buildQuestions(criteria: Record<string, string>): JevQuestions {
  return {
    dispatch: {
      type: 'noul',
      instructions:
        'Is the request in this turn better served by handing it to one of the agents in the `agent` question than by the main agent doing it itself? Judge the FIT of a specialist with a clearly bounded capability domain — not the size of the task, and not whether a subagent could technically do it.',
      criteria: {
        true:
          'The work matches one agent\'s stated specialty: a self-contained job that agent can finish from its own description without this conversation\'s context.',
        false:
          'The main agent should do it: a continuation of this conversation, a quick local edit, a question to answer, or work every agent would handle identically.',
      },
    },
    agent: {
      type: 'choice',
      instructions:
        'Which agent should take this task? Choose `none` when no registered agent is a better fit than the main agent handling it in this session.',
      criteria,
    },
    risky: {
      type: 'noul',
      instructions:
        'Carrying this task out changes state that is hard to undo: credentials and secrets, production or user data, schema migrations, deploys, or destructive file operations.',
      criteria: {
        true:
          'Credentials, production data, migrations, deploys, or irreversible operations are in play — a mistake here is not recoverable by editing a file.',
        false:
          'Ordinary local code, test, or documentation changes that can be reverted by editing files.',
      },
    },
    long_running: {
      type: 'noul',
      instructions:
        'This task needs sustained multi-step work that would hold the main agent\'s turn open while it runs.',
      criteria: {
        true:
          'The work takes many steps or a long time and the main agent would otherwise stay blocked on it.',
        false:
          'The work is bounded and quick enough to do inline in this turn.',
      },
    },
  }
}

/** The `agent` question's options plus the map back to real agent ids. */
export interface AgentOptions {
  /** Option name → capability text. Includes the `none` abstention, last. */
  criteria: Record<string, string>
  /**
   * Option name → the agent id `use_agent` expects. An option label is
   * `name (display_name)` for readability, so the pick jev returns is NOT
   * callable as-is; this is the translation, and a pick missing from it is a
   * pick the plugin refuses to act on.
   */
  agentByOption: Record<string, string>
}

/** The `none` option's description. */
export const NO_AGENT_DESCRIPTION = 'No registered agent fits better than the main agent — the task should stay in this session.'

/**
 * Build the `agent` choice options from the roster, in roster order, with
 * `none` appended last. Reads the roster structurally rather than re-parsing
 * rendered lines: the rendered form is documentation, this is the wire data.
 */
export function agentOptions(roster: Roster): AgentOptions {
  const criteria: Record<string, string> = {}
  const agentByOption: Record<string, string> = {}
  for (const agent of roster.agents) {
    const entry = criteriaEntry(agent)
    criteria[entry.label] = entry.description
    agentByOption[entry.label] = agent.meta.name
  }
  criteria[NO_AGENT] = NO_AGENT_DESCRIPTION
  agentByOption[NO_AGENT] = NO_AGENT
  return { criteria, agentByOption }
}

/**
 * Translate a jev pick into the agent id `use_agent` takes. Returns null for
 * `none` and for any option this request never offered — a rubric that
 * answers with an unknown option is a response this plugin will not guess at.
 */
export function resolvePick(option: string | null, options: AgentOptions): string | null {
  if (option === null || option === NO_AGENT) return null
  return options.agentByOption[option] ?? null
}
