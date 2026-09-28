/**
 * `@aiwayds/dsh-agent-dispatch` — the runtime capability gate.
 *
 * A dispatch suggestion is only worth a jev call when the agent can actually
 * dispatch. Four things must hold, and NONE of them is implied by this plugin
 * being installed, so all four are re-verified on every request against the
 * live host:
 *
 *  1. the dispatch tool (`use_agent`, from dsh-subagent-registry) is visible
 *     to THIS agent — the host's own `subagent` tool is hidden when
 *     `disableSubagent` is on, and the registry's tool disappears with the
 *     plugin, so visibility is probed, never assumed;
 *  2. the subagent provider behind it is registered on `ctx.subagents`;
 *  3. the roster is non-empty — recommending "hand it to an agent" with no
 *     agent to hand it to is worse than saying nothing;
 *  4. there is delegation depth left for a child.
 *
 * Two hard-won corrections to the community sibling (`dsh-jev-subagent-dispatch`)
 * are baked in: the probe looks for `use_agent` (its `subagent`-first probe is
 * guaranteed dead on a default profile), and the depth leg does NOT lean on
 * `resolveMaxDepth()` being binding for `use_agent` — the tool passes an
 * explicit `maxDepth = childDepth + deep`, so the budget that can actually
 * reject the dispatch is the host's cap versus `sessionDepth + 1 + childDeep`.
 * Check 4 is therefore the target-independent necessary condition (room for at
 * least one child); the exact per-agent arithmetic runs in `policy.ts` once the
 * pick is known. An unreadable `maxDepth` is UNKNOWN, not zero — a host that
 * does not report the cap is not a host without delegation.
 *
 * @module
 */

import type { DispatchConfig } from './config.ts'
import type { Roster } from './roster.ts'

/** The slice of the host services this gate reads. Every member is optional. */
export interface CapabilityServices {
  tools?: { get?: (name: string, scope?: unknown) => unknown } | undefined
  subagents?: {
    getProvider?: (name: string) => unknown
    resolveMaxDepth?: () => unknown
  } | undefined
}

/** The agent fields this gate reads, structurally typed. */
export interface DispatchAgentLike {
  session?: {
    id?: string
    header?: { origin?: string; delegationDepth?: number }
  } | undefined
  options?: { subagentDepth?: number } | undefined
  cwd?: string | undefined
}

export interface CapabilityReport {
  ok: boolean
  /** Human-readable gaps, in check order; empty when `ok`. */
  missing: string[]
  /** The session's current delegation depth (0 at top level). */
  sessionDepth: number
  /** The host's delegation depth cap, or null when it does not report one. */
  maxDepth: number | null
}

function tryCall<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Read an agent's delegation depth the way the subagent service does: the
 * persisted session header is the monotone floor, runtime options may deepen
 * it. Absence means top-level depth zero.
 */
export function sessionDepthOf(agent: DispatchAgentLike | null | undefined): number {
  const header = agent?.session?.header?.delegationDepth
  const runtime = agent?.options?.subagentDepth
  return Math.max(Number.isFinite(header) ? (header as number) : 0, Number.isFinite(runtime) ? (runtime as number) : 0)
}

/** Whether this session is a subagent's own session (advising it would recurse). */
export function isSubagentSession(agent: DispatchAgentLike | null | undefined): boolean {
  return agent?.session?.header?.origin === 'subagent'
}

/**
 * Verify the agent can dispatch before any jev call is made.
 * @param services - `{ tools, subagents }` resolved from the host at request
 *   time (each may be undefined).
 * @param agent - the agent that would receive the advice.
 * @param config - resolved plugin configuration (tool and provider names).
 * @param roster - the roster snapshot read for this request.
 * @returns the report; `missing` is the diagnostic an explicit request sees.
 */
export function checkDispatchCapabilities(
  services: CapabilityServices | undefined,
  agent: DispatchAgentLike | null | undefined,
  config: Pick<DispatchConfig, 'toolName' | 'provider'>,
  roster: Pick<Roster, 'agents'>,
): CapabilityReport {
  const missing: string[] = []
  const sessionDepth = sessionDepthOf(agent)

  const tool = tryCall(() => services?.tools?.get?.(config.toolName, agent))
  if (tool === undefined) {
    missing.push(`the dispatch tool "${config.toolName}" is not visible to this agent (is dsh-subagent-registry installed, and are its tools enabled for this session?)`)
  }

  const provider = tryCall(() => services?.subagents?.getProvider?.(config.provider))
  if (provider === undefined) {
    missing.push(`the subagent provider "${config.provider}" is not registered`)
  }

  if (roster.agents.length === 0) {
    missing.push('no agent is registered (the agents directory is empty or unreadable)')
  }

  const rawMaxDepth = tryCall(() => services?.subagents?.resolveMaxDepth?.())
  const maxDepth = typeof rawMaxDepth === 'number' && Number.isFinite(rawMaxDepth) ? rawMaxDepth : null
  // Necessary, target-independent half of the depth budget: a child needs one
  // level. The per-agent half (the child's own `deep`) needs the pick, so it
  // lives in the policy layer.
  if (maxDepth !== null && sessionDepth + 1 > maxDepth) {
    missing.push(`delegation depth is exhausted (this session is at depth ${sessionDepth}, the host allows ${maxDepth})`)
  }

  return { ok: missing.length === 0, missing, sessionDepth, maxDepth }
}

/**
 * Whether a specific pick still fits the depth budget. Returns the reason when
 * it does not, or null when it does (or when the host reports no cap, which is
 * unknown rather than zero).
 * @param report - the gate report for this request.
 * @param childDeep - the recommended agent's frontmatter `deep` (0 = leaf).
 */
export function depthConflict(report: CapabilityReport, childDeep: number): string | null {
  if (report.maxDepth === null) return null
  const needed = report.sessionDepth + 1 + (Number.isFinite(childDeep) ? childDeep : 0)
  if (needed <= report.maxDepth) return null
  return `the pick needs delegation depth ${needed} (session ${report.sessionDepth} + 1 + agent deep ${childDeep}) but the host allows ${report.maxDepth}`
}
