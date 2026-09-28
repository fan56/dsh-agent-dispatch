/**
 * `@aiwayds/dsh-agent-dispatch` — the agent roster data surface.
 *
 * The dispatch rubric asks "which agent?", so its `choice` criteria ARE the
 * roster. That makes the roster's parse strictness load-bearing: a loose parse
 * would let jev recommend an agent that `use_agent` refuses to execute, which
 * is worse than not recommending. Therefore this module is a deliberate port
 * of `dsh-subagent-registry`'s parser (`src/agents-dir.ts`) and description
 * sanitizer, field for field, and the two must be kept in step — the registry's
 * fail-loud rules (unknown `thinking`, non-boolean `background`, non-positive
 * `maxRounds`, missing `name`) all mark the whole file broken, and so do these.
 *
 * Read path: the agents directory itself (`$DSH_HOME/agents`, i.e.
 * `~/.dsh/agents`), fresh on every request, never cached — the roster is
 * editable at runtime and a stale criteria set would recommend a deleted
 * agent. Deliberately NOT probed through the registry's public API (it exports
 * no listing) and NOT read from a service (the host has none).
 *
 * Deliberately NOT in the criteria: the composed `model`. On a deployed
 * profile the frontmatter `model` is routinely stale (a pinned profile
 * overrides it), a wrong model is more harmful than an absent one, and "where
 * does it run" is not the question being asked — "who runs it" is.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Valid frontmatter `thinking` values, in canonical order. */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** One agent's frontmatter-derived metadata. */
export interface AgentMeta {
  /** File basename without `.md` — required, the stable agent id. */
  name: string
  displayName?: string
  description?: string
  /** Parsed for parse-strictness parity only; never surfaced to jev. */
  model?: string
  thinking?: ThinkingLevel
  /** Spawn-depth budget: default 1 (may start subagents), 0 = leaf. */
  deep: number
  background?: boolean
  maxRounds?: number
}

/** A parsed agent file: metadata + the raw system-prompt body. */
export interface AgentFile {
  path: string
  meta: AgentMeta
  body: string
}

export type AgentParseResult =
  | { ok: true; agent: AgentFile }
  | { ok: false; error: string }

/** A roster snapshot: the usable agents and the files that failed to parse. */
export interface Roster {
  agents: AgentFile[]
  broken: { path: string; error: string }[]
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (dir === '~') return env['HOME'] ?? homedir()
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return join(env['HOME'] ?? homedir(), dir.slice(2))
  return dir
}

/**
 * The dsh home directory: `$DSH_HOME` when set, `~/.dsh` otherwise — the same
 * resolution the host and the registry use, so agents live under one root.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['DSH_HOME'] ?? join(env['HOME'] ?? homedir(), '.dsh')
}

/** The default agents directory (`$DSH_HOME/agents`). */
export function agentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'agents')
}

/**
 * Resolve a configured `agentsDir`. The default literal means "the agents dir
 * under the dsh home" (so `$DSH_HOME` keeps working after the fact); anything
 * else is a real path, taken verbatim after `~` expansion.
 */
export function resolveAgentsDir(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  return configured === '~/.dsh/agents' ? agentsDir(env) : expandHome(configured, env)
}

const FRONTMATTER_FENCE = '---'
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

function frontmatterBounds(lines: string[]): { close: number } | undefined {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return undefined
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_FENCE) return { close: i }
  }
  return undefined
}

function parseFrontmatterValues(lines: string[], close: number): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 1; i < close; i++) {
    const match = KEY_LINE.exec(lines[i] ?? '')
    if (match === null) continue
    values[match[1] as string] = stripQuotes(match[2]?.trim() ?? '')
  }
  return values
}

/**
 * Parse one agent markdown file, with the registry's strict rules: `name` is
 * required, `deep` must be a non-negative integer, `thinking` must be on the
 * whitelist, `background` a strict boolean, `maxRounds` a positive integer —
 * any violation drops the whole file from the roster (fail loud, because a
 * silently-accepted typo would recommend an agent `use_agent` cannot run).
 * Unknown keys are ignored, exactly as the registry ignores them: an
 * `extensions` block is not a capability signal.
 */
export function parseAgentMarkdown(text: string, path: string): AgentParseResult {
  const lines = text.split(/\r?\n/)
  const bounds = frontmatterBounds(lines)
  if (bounds === undefined) {
    return { ok: false, error: 'missing frontmatter (file must start with `---`)' }
  }
  const values = parseFrontmatterValues(lines, bounds.close)
  const name = values['name']?.trim()
  if (name === undefined || name === '') return { ok: false, error: 'missing required frontmatter key `name`' }
  let deep = 1
  if (values['deep'] !== undefined) {
    const raw = values['deep']?.trim() ?? ''
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: `invalid \`deep\`: expected a non-negative integer, got "${raw}"` }
    }
    deep = Number(raw)
  }
  const body = lines.slice(bounds.close + 1).join('\n').replace(/^\n+/, '').trimEnd()
  const meta: AgentMeta = { name, deep }
  const displayName = values['display_name']?.trim()
  if (displayName !== undefined && displayName !== '') meta.displayName = displayName
  const description = values['description']?.trim()
  if (description !== undefined && description !== '') meta.description = description
  const model = values['model']?.trim()
  if (model !== undefined && model !== '') meta.model = model
  const thinking = values['thinking']?.trim()
  if (thinking !== undefined && thinking !== '') {
    if (!isThinkingLevel(thinking)) {
      return { ok: false, error: `invalid \`thinking\`: expected one of ${THINKING_LEVELS.join('/')}, got "${thinking}"` }
    }
    meta.thinking = thinking
  }
  const background = values['background']?.trim()
  if (background !== undefined && background !== '') {
    if (background !== 'true' && background !== 'false') {
      return { ok: false, error: `invalid \`background\`: expected true or false, got "${background}"` }
    }
    meta.background = background === 'true'
  }
  const maxRounds = values['maxRounds']?.trim()
  if (maxRounds !== undefined && maxRounds !== '') {
    if (!/^\d+$/.test(maxRounds ?? '') || Number(maxRounds) < 1) {
      return { ok: false, error: `invalid \`maxRounds\`: expected a positive integer, got "${maxRounds}"` }
    }
    meta.maxRounds = Number(maxRounds)
  }
  return { ok: true, agent: { path, meta, body } }
}

/**
 * Clean one description for presentation in a criteria line. Ported verbatim
 * from the registry's `sanitizeDescription`: YAML escapes leak into the
 * description string (leading backslashes, `>` between CJK characters, doubled
 * quotes), and all three distort a rubric criterion.
 */
export function sanitizeDescription(raw: string): string {
  let s = raw ?? ''
  s = s.replace(/^\\+/, '')
  s = s.trim()
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) s = s.slice(1, -1)
  }
  s = s.replace(/\\/g, '')
  s = s.replace(/([一-鿿]|[㐀-䶿])>([一-鿿]|[㐀-䶿])/g, '$1$2')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/** The longest description a criteria line carries before truncation kicks in. */
export const MAX_DESCRIPTION_CHARS = 120
/** Below this, a frontmatter description is too thin to describe a capability. */
export const MIN_DESCRIPTION_CHARS = 20

const SENTENCE_END = /[.。!！?？]/

/**
 * Cut at the first sentence end within the cap, else hard-cut at the cap. A
 * first sentence longer than the cap cannot be kept whole, so the cap wins —
 * the alternative (an unbounded line) is worse inside a criteria map.
 */
export function firstSentence(text: string, max: number = MAX_DESCRIPTION_CHARS): string {
  const value = text.trim()
  for (let i = 0; i < value.length && i < max; i++) {
    if (SENTENCE_END.test(value[i] as string)) return value.slice(0, i + 1)
  }
  return value.slice(0, max)
}

/**
 * Bound a description to `max` characters while keeping its first sentence: the
 * first sentence is where an agent's scope is stated, and a mid-sentence cut
 * reads as a different (broader or narrower) claim than the file makes.
 */
export function boundDescription(text: string, max: number = MAX_DESCRIPTION_CHARS): string {
  const value = text.trim()
  return value.length <= max ? value : firstSentence(value, max)
}

/** The first sentence of the agent's body — where a system prompt states its scope. */
function firstBodySentence(body: string, max: number = MAX_DESCRIPTION_CHARS): string {
  const firstLine = sanitizeDescription(body.split('\n').find((line) => line.trim() !== '') ?? '')
  return firstLine === '' ? '' : firstSentence(firstLine, max)
}

/**
 * The one-line capability summary for the `agent` choice criteria, through the
 * documented fallback chain: a usable frontmatter description (bounded to the
 * first sentence), else the body's first sentence, else the display name, else
 * the agent name. An agent with nothing at all still gets a line — dropping it
 * would silently shrink the choice space jev reasons over.
 */
export function criteriaDescription(agent: AgentFile): string {
  const description = sanitizeDescription(agent.meta.description ?? '')
  if (description.length >= MIN_DESCRIPTION_CHARS) return boundDescription(description)
  const fromBody = firstBodySentence(agent.body)
  if (fromBody.length >= MIN_DESCRIPTION_CHARS) return fromBody
  return agent.meta.displayName ?? agent.meta.name
}

/** Short, factual suffixes: what kind of agent this is, not what it may promise. */
function criteriaMeta(agent: AgentFile): string {
  const parts: string[] = []
  if (agent.meta.deep === 0) parts.push('[leaf]')
  if (agent.meta.maxRounds !== undefined) parts.push(`· rounds cap ${agent.meta.maxRounds}`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** One agent as a rubric option: a human-readable label and its capability text. */
export interface CriteriaEntry {
  /** `- <name> (<display_name>)` when a display name exists, else `- <name>`. */
  label: string
  /** The bounded description plus the short metadata suffix. */
  description: string
}

/**
 * One roster line, split into the two parts the rubric needs. The LABEL is a
 * rubric option name and is NOT the agent id: with a display name the label
 * reads `workhorse (牛马狗)`, while `use_agent` must be called with `workhorse`.
 * The mapping back to the id lives with the question set (`rubric.ts`).
 */
export function criteriaEntry(agent: AgentFile): CriteriaEntry {
  return {
    label: agent.meta.displayName !== undefined
      ? `${agent.meta.name} (${agent.meta.displayName})`
      : agent.meta.name,
    description: `${criteriaDescription(agent)}${criteriaMeta(agent)}`,
  }
}

/**
 * Render the roster as `- <name> (<display_name>): <description>`, the same
 * line shape the registry renders into the `use_agent` tool description, so
 * jev's criteria and the model's own tool roster describe the agents
 * identically. Unparsable files are reported on a trailing line (basenames
 * only — absolute paths are host noise in a rubric criterion).
 */
export function criteriaLines(roster: Roster): string[] {
  const lines = roster.agents.map((agent) => {
    const entry = criteriaEntry(agent)
    return `- ${entry.label}: ${entry.description}`
  })
  if (roster.broken.length > 0) {
    lines.push(`- (unparsable agents excluded: ${roster.broken.map((entry) => basename(entry.path)).join(', ')})`)
  }
  return lines
}

/**
 * Read the roster from disk. Fresh on every call by design: the agents
 * directory is editable at runtime and a cached snapshot would recommend a
 * deleted agent. A missing directory is an empty roster (not an error) — the
 * capability gate reports it as "no agents registered".
 */
export async function loadRoster(dir: string): Promise<Roster> {
  if (!existsSync(dir)) return { agents: [], broken: [] }
  const entries = await readdir(dir, { withFileTypes: true })
  const agents: AgentFile[] = []
  const broken: { path: string; error: string }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(dir, entry.name)
    const result = parseAgentMarkdown(await readFile(path, 'utf8'), path)
    if (result.ok) agents.push(result.agent)
    else broken.push({ path, error: result.error })
  }
  agents.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  return { agents, broken }
}
