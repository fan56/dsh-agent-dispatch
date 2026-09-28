/**
 * `@aiwayds/dsh-agent-dispatch` — the rubric, the turn triggers, and the local
 * `auto` keyword gate.
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
 * turn completely untouched (no call, no data sharing, no log line). Under
 * `mode: 'auto'` a turn without a trigger is not finished with yet: it still
 * has to clear the local keyword gate (`findKeyword`) below, which is the only
 * difference `auto` adds at this layer.
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

/** A local keyword-gate hit, shaped like `Trigger` so the caller logs the same way. */
export interface KeywordHit {
  /** The dictionary entry that matched, verbatim as configured. */
  keyword: string
}

/** Escape a substring for literal use inside a RegExp (keywords are user config). */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether a keyword is printable ASCII, and therefore word-bounded at match time. */
function isAsciiWord(keyword: string): boolean {
  return !/[^\x20-\x7E]/.test(keyword)
}

/**
 * One common inflection is allowed right after a matched ASCII keyword, so a
 * dictionary entry is the STEM and not one conjugation: `fixing`, `fixed`,
 * `tests`, `deployment` all hit `fix`/`test`/`deploy`. `prefix`, `address` and
 * `addressing` stay misses because the character after the stem is not one of
 * these — the boundary check then rejects it.
 */
const ASCII_INFLECTION = '(?:s|es|ed|ing|ment|ments)'

/**
 * What counts as part of a word: letters, digits, underscore. Hyphens and
 * punctuation are separators, so `fix-me` and `the e2e-test is red` match while
 * the identifier `fix_it` does not.
 */
const WORD_CHAR = 'A-Za-z0-9_'

/**
 * What may stand between the words of a MULTI-word entry: a run of anything
 * that is not a letter, a digit, or an underscore. Whitespace alone would make
 * `help me` demand the user's own spacing, while `help,me` and `help-me` are
 * the same request typed differently. `_` stays a word character, so the
 * identifier `help_me` still misses. Needs the `u` flag (`\p{...}`).
 */
const WORD_SEPARATOR = '[^\\p{L}\\p{N}_]+'

/**
 * The regex body for one ASCII keyword. A single word stays literal (trailing
 * space and all); a multi-word entry gets `WORD_SEPARATOR` between its words,
 * each still escaped by `literal`, so `help me` / `help,me` / `help  me` /
 * `help-me` are one entry while `helpXme` is not.
 */
function keywordBody(needle: string): string {
  const words = needle.split(/\s+/).filter((word) => word.length > 0)
  if (words.length < 2) return literal(needle)
  return words.map((word) => literal(word)).join(WORD_SEPARATOR)
}

/**
 * The copy of a text the gate matches against: NFKC-folded (so a full-width
 * `ｆｉｘ` from an un-switched input method matches `fix`) with whitespace runs
 * collapsed to one space (so `help  me` and `help\nme` match `help me`). This is
 * a COPY — the caller's text, the state sent to jev, and every log line keep
 * the user's bytes.
 */
function matchable(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ')
}

/**
 * The local gate for `mode: 'auto'`: does this turn even mention work?
 *
 * Zero network, zero clock, zero state — a deterministic string match over the
 * turn's PLAIN user text, the same population `findTrigger` reads, so this
 * plugin's own injected advice can never re-arm the gate. The first hit wins
 * (message order, then dictionary order), matching `findTrigger`'s style.
 *
 * Matching is deliberately two-mode, on a folded copy of the text: ASCII
 * keywords are word-bounded and take one common inflection, so `fix` misses
 * `prefix` but covers `fixing`; Chinese has no word boundaries, so a substring
 * IS a word there. Both sides are lowercased and folded first. Inside a
 * multi-word entry the words are joined by `WORD_SEPARATOR`, so punctuation
 * separates them just as whitespace does.
 * @param messages - the claimed messages for this step.
 * @param keywords - the `autoKeywords` dictionary (ignored when not `auto`).
 * @returns the hit keyword, or null when the turn stays local and silent.
 */
export function findKeyword(
  messages: readonly DispatchMessage[] | null | undefined,
  keywords: readonly string[],
): KeywordHit | null {
  for (const message of messages ?? []) {
    if (!isPlainUserMessage(message)) continue
    const text = matchable(messageText(message).toLowerCase())
    if (text.length === 0) continue
    for (const keyword of keywords ?? []) {
      if (typeof keyword !== 'string' || keyword === '') continue
      const needle = matchable(keyword.toLowerCase())
      if (!isAsciiWord(needle)) {
        if (text.includes(needle)) return { keyword }
        continue
      }
      const bounded = new RegExp(
        `(?<![${WORD_CHAR}])${keywordBody(needle)}${ASCII_INFLECTION}?(?![${WORD_CHAR}])`,
        'u',
      )
      if (bounded.test(text)) return { keyword }
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
