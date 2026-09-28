/**
 * `@aiwayds/dsh-jev-dispatch` — configuration resolution.
 *
 * One configuration source: the plugin row's `config` in the dsh bundle patch
 * (the shipped patch is empty; a profile patch overrides the same row by id,
 * and with `patchReload: live` edits apply without a restart).
 *
 * The thresholds live in one `thresholds` object rather than being scattered
 * across the rubric, because they are the only numbers a user calibrating from
 * the verdict log will touch — each one is independently overridable and each
 * is read in exactly one place (`policy.ts`).
 *
 * Merging is a deep merge over plain objects; arrays and scalars replace. A
 * broken config throws at composition time with a human message: silently
 * mis-thresholding every verdict is worse than refusing to mount.
 *
 * @module
 */

export const PLUGIN_NAME = 'dsh-jev-dispatch'
/** The `MessageSource.kind` this plugin stamps on its injected messages. */
export const PLUGIN_SOURCE_KIND = `plugin:${PLUGIN_NAME}`

/**
 * Activation model.
 *
 * - `off` (default) registers no listener at all — the plugin is inert and
 *   makes no network call, ever.
 * - `once` registers the pre-step listener but classifies ONLY turns that
 *   explicitly ask for a verdict (`/dispatch <task>` or `/jev <question>`):
 *   one call per request, predictable cost and data sharing.
 *
 * `auto` (classify every plain user turn) is deliberately absent: the map
 * parks it in fog until the `once` verdict log has earned it.
 */
export type DispatchMode = 'off' | 'once'

/**
 * The System One calibration values from the dispatch rubric decision:
 * `dispatch` names a delegation band (middle = uncertainty = skip), `agent`
 * gates on both confidence and the top1−top2 margin (a tie is noise),
 * `risky` vetoes delegation on its high segment only, and `long_running`
 * turns the advice into a `background: true` dispatch.
 */
export const DEFAULT_THRESHOLDS = {
  /** `dispatch` noul ≥ this → the turn is worth a delegation suggestion. */
  dispatchRecommend: 0.6,
  /** `dispatch` noul ≤ this → recorded skip (no delegation needed). */
  dispatchSkip: 0.35,
  /** `agent` choice confidence floor. */
  agentConfidence: 0.7,
  /** Minimum top1−top2 probability margin between the best and second agent. */
  agentMargin: 0.15,
  /** `risky` noul ≥ this → hold the delegation back and say so. */
  risky: 0.75,
  /** `long_running` noul ≥ this → the advice carries `background: true`. */
  longRunning: 0.7,
} as const

export type Thresholds = { -readonly [K in keyof typeof DEFAULT_THRESHOLDS]: number }

export interface DispatchConfig {
  mode: DispatchMode
  /**
   * Agent roster root. The default literal is resolved against the dsh home
   * (`$DSH_HOME` ?? `~/.dsh`) exactly like the registry plugin, so a profile
   * that relocates DSH_HOME needs no per-plugin path; any other value is taken
   * verbatim (after `~` expansion).
   */
  agentsDir: string
  /** The dispatch tool that must be visible for a recommendation to be actionable. */
  toolName: string
  /** The subagent provider behind that tool (`spawn` in dsh-base). */
  provider: string
  /** Turn triggers parsed from the user's own text; each must start with `/`. */
  triggers: string[]
  /**
   * Total deadline for one jev call, in ms. Deliberately well under
   * `@aiwayds/dsh-jev-core`'s 5s default: the call sits inline in the
   * pre-step waterfall, so a slow verdict must not hold the turn open. Raise
   * it once the verdict log shows real latencies clearing it.
   */
  timeoutMs: number
  /** Head cap for the state text sent to jev. */
  stateChars: number
  /** Pinned jev model id; `null` defers to the core's default. */
  model: string | null
  thresholds: Thresholds
  /** A subagent's own turn never dispatches another agent (no advice recursion). */
  skipSubagentSessions: boolean
  /** Opt-in NDJSON verdict log directory; `null`/`""` disables logging entirely. */
  logDir: string | null
  /** Extra credential-shaped regex sources, applied on top of the built-in set. */
  redactPatterns: string[]
  /** Whether the injected advice ends with the "ignore this if it does not fit" line. */
  includeDismissLine: boolean
}

export function defaults(): DispatchConfig {
  return {
    mode: 'off',
    agentsDir: '~/.dsh/agents',
    toolName: 'use_agent',
    provider: 'spawn',
    triggers: ['/dispatch', '/jev'],
    timeoutMs: 2_000,
    stateChars: 1_200,
    model: null,
    thresholds: { ...DEFAULT_THRESHOLDS },
    skipSubagentSessions: true,
    logDir: null,
    redactPatterns: [],
    includeDismissLine: true,
  }
}

const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]

/** Deep-merge plain objects; arrays, maps keyed by id, and scalars replace. */
export function mergeDefaults<T>(defaultsValue: T, input: unknown): T {
  if (input === undefined || input === null) return structuredClone(defaultsValue)
  if (
    typeof defaultsValue !== 'object' || defaultsValue === null || Array.isArray(defaultsValue)
    || typeof input !== 'object' || input === null || Array.isArray(input)
  ) {
    return input as T
  }
  const out: Record<string, unknown> = { ...(defaultsValue as Record<string, unknown>) }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = key in out ? mergeDefaults(out[key], value) : value
  }
  return out as T
}

const MODES: readonly DispatchMode[] = ['off', 'once']

/**
 * Validate a merged configuration. Throws with a human message on the first
 * structural problem — a bad threshold must fail at mount, not silently
 * inverts a policy at verdict time.
 * @param config - the merged configuration.
 * @returns the same object, validated.
 */
export function validate(config: DispatchConfig): DispatchConfig {
  const where = `${PLUGIN_NAME} config`
  if (!MODES.includes(config.mode)) {
    throw new Error(`${where}: mode must be one of ${MODES.join(', ')}`)
  }
  if (typeof config.agentsDir !== 'string' || config.agentsDir.trim() === '') {
    throw new Error(`${where}: agentsDir must be a directory path`)
  }
  if (typeof config.toolName !== 'string' || config.toolName.trim() === '') {
    throw new Error(`${where}: toolName must name the dispatch tool (dsh-subagent-registry ships it as "use_agent")`)
  }
  if (typeof config.provider !== 'string' || config.provider.trim() === '') {
    throw new Error(`${where}: provider must name the subagent provider (dsh-base assembles it as "spawn")`)
  }
  if (!Array.isArray(config.triggers) || config.triggers.length === 0
    || !config.triggers.every((trigger) => typeof trigger === 'string' && trigger.startsWith('/'))) {
    throw new Error(`${where}: triggers must be a non-empty array of "/command" strings`)
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 50) {
    throw new Error(`${where}: timeoutMs must be a number >= 50`)
  }
  if (!Number.isFinite(config.stateChars) || config.stateChars < 100) {
    throw new Error(`${where}: stateChars must be a number >= 100`)
  }
  if (config.model !== null && (typeof config.model !== 'string' || config.model === '')) {
    throw new Error(`${where}: model must be a jev model id, or null for the core default`)
  }
  const thresholds = config.thresholds
  if (typeof thresholds !== 'object' || thresholds === null || Array.isArray(thresholds)) {
    throw new Error(`${where}: thresholds must be an object`)
  }
  for (const key of THRESHOLD_KEYS) {
    const value = thresholds[key]
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${where}: thresholds.${key} must be a probability in [0, 1]`)
    }
  }
  if (thresholds.dispatchSkip > thresholds.dispatchRecommend) {
    throw new Error(`${where}: thresholds.dispatchSkip (${thresholds.dispatchSkip}) must not exceed thresholds.dispatchRecommend (${thresholds.dispatchRecommend})`)
  }
  if (config.logDir !== null && config.logDir !== '' && typeof config.logDir !== 'string') {
    throw new Error(`${where}: logDir must be a directory path, or null/"" to disable logging`)
  }
  if (!Array.isArray(config.redactPatterns) || config.redactPatterns.some((pattern) => typeof pattern !== 'string')) {
    throw new Error(`${where}: redactPatterns must be an array of regex source strings`)
  }
  if (typeof config.skipSubagentSessions !== 'boolean') {
    throw new Error(`${where}: skipSubagentSessions must be a boolean`)
  }
  if (typeof config.includeDismissLine !== 'boolean') {
    throw new Error(`${where}: includeDismissLine must be a boolean`)
  }
  return config
}

/**
 * Merge the plugin row's `config` over the defaults and validate.
 * @param input - the cordis row config (may be undefined).
 * @returns a fully-populated, validated configuration.
 */
export function resolveConfig(input: unknown = {}): DispatchConfig {
  return validate(mergeDefaults(defaults(), input))
}

/** Whether the opt-in verdict log is on (a non-empty directory path). */
export function loggingEnabled(config: DispatchConfig): boolean {
  return typeof config.logDir === 'string' && config.logDir !== ''
}
