/**
 * `@aiwayds/dsh-jev-dispatch` — the outbound state and its redaction.
 *
 * Everything this plugin sends to TypeSafe is assembled here, so this is the
 * only module that has to be right about what leaves the machine. Two rules:
 *
 * 1. Credential-shaped strings are replaced BEFORE the state is assembled into
 *    its final form and before it is capped — including the workspace path,
 *    which travels through the same filters as the task text.
 * 2. Only plain user text is shipped. Plugin- and tool-authored messages (this
 *    plugin's own past injections included) are filtered out, so a verdict
 *    never gets re-classified from a previous verdict, and non-text content is
 *    dropped: binaries and image payloads never go to a decision model.
 *
 * @module
 */

/**
 * Credential shapes replaced in every outbound state. The built-in set covers
 * the families a coding session actually encounters (provider keys, GitHub
 * tokens, AWS ids, bearer headers, `api_key=` assignments, long base64 blobs);
 * `redactPatterns` adds deployment-specific shapes on top.
 */
export const BUILT_IN_REDACT_PATTERNS: readonly string[] = [
  String.raw`\bsk-[A-Za-z0-9_-]{16,}\b`,
  String.raw`\bpk_(?:live|test)_[A-Za-z0-9_-]{16,}\b`,
  String.raw`\bghp_[A-Za-z0-9]{20,}\b`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}\b`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bBearer\s+[A-Za-z0-9._-]{10,}`,
  String.raw`\b(?:api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[=:]\s*\S+`,
  String.raw`\b(?=[A-Za-z0-9+/_-]{40,})(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]+(?:={0,2})\b`,
]

/**
 * Replace credential-shaped substrings with a marker.
 * @param text - arbitrary text.
 * @param extraPatterns - additional RegExp source strings (user-supplied).
 * @returns the redacted text; an invalid user pattern is skipped, never thrown.
 */
export function redact(text: string, extraPatterns: readonly string[] = []): string {
  let out = String(text ?? '')
  for (const source of [...extraPatterns, ...BUILT_IN_REDACT_PATTERNS]) {
    try {
      out = out.replace(new RegExp(source, 'gi'), '[redacted]')
    } catch {
      // A broken user pattern must not break dispatch; skip it.
    }
  }
  return out
}

/** A conversation message in the shape this plugin reads (structurally typed). */
export interface DispatchMessage {
  role?: string
  content?: unknown
  source?: { kind?: string } | null
}

/** Concatenate the text parts of one message. */
export function messageText(message: DispatchMessage | null | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text: string } =>
      (part as { type?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Whether a message is a real user turn rather than a plugin or synthetic
 * injection. Plugin producers stamp their own `source.kind`
 * (`plugin:dsh-jev-dispatch`, legacy `plugin`, …), so anything carrying a
 * non-user kind is excluded from the state.
 */
export function isPlainUserMessage(message: DispatchMessage | null | undefined): boolean {
  if (message?.role !== 'user') return false
  const kind = message?.source?.kind
  return kind === undefined || kind === 'user' || kind === null
}

/** The plain user texts of a turn, trimmed and empties dropped. */
export function userTurnTexts(messages: readonly DispatchMessage[] | null | undefined): string[] {
  return (messages ?? [])
    .filter((message) => isPlainUserMessage(message))
    .map((message) => messageText(message).trim())
    .filter((text) => text.length > 0)
}

/**
 * Assemble the state under evaluation: the explicit decision request (when the
 * turn was triggered) leads, then the user's own turns, then the workspace
 * path. Redaction runs on the COMPLETE assembly and the cap applies to the
 * redacted whole, so a long path can neither exceed `stateChars` nor push the
 * task out of the payload.
 * @returns the state string, or `""` when there is nothing user-authored.
 */
export function buildState(
  messages: readonly DispatchMessage[] | null | undefined,
  cwd: string,
  stateChars: number,
  extraRedactPatterns: readonly string[] = [],
  explicitTask = '',
): string {
  const task = String(explicitTask ?? '').trim()
  const turns = userTurnTexts(messages)
  const body = task.length > 0 ? [task, ...turns] : turns
  if (body.length === 0) return ''
  const state = redact(`workspace: ${cwd}\ntask:\n${body.join('\n---\n')}`, extraRedactPatterns)
  return state.length > stateChars ? state.slice(0, Math.max(0, stateChars)) : state
}

/**
 * A one-line excerpt of the task for the injected advice. Prefers the
 * explicit request text, falls back to the last user turn, and is redacted and
 * bounded like everything else outbound.
 */
export function taskExcerpt(
  messages: readonly DispatchMessage[] | null | undefined,
  explicitTask: string,
  extraRedactPatterns: readonly string[] = [],
  max = 200,
): string {
  const turns = userTurnTexts(messages)
  const source = explicitTask.trim().length > 0 ? explicitTask : (turns.at(-1) ?? '')
  const flat = redact(source, extraRedactPatterns).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
