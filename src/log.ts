/**
 * `@aiwayds/dsh-agent-dispatch` — the verdict log.
 *
 * Opt-in (a configured `logDir` turns it on, nothing else does) and append-only
 * NDJSON: one JSON object per line, so a calibration run is a `jq` pipeline and
 * a half-written line costs at most one row.
 *
 * The log is the ONLY channel that sees every verdict, including the ones that
 * injected nothing — that is the point: a threshold nobody can inspect is a
 * threshold nobody can tune. What the log still cannot see is whether the main
 * agent FOLLOWED the advice; measuring that is a routing ledger's job, not
 * this plugin's.
 *
 * Logging never breaks a turn: a failed append is a `warn` and nothing more.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_NAME } from './config.ts'

/** The file verdicts are appended to inside `logDir`. */
export const VERDICT_FILE = 'verdicts.ndjson'

export interface VerdictRecord {
  at: string
  session: string | null
  mode: string
  /** The trigger word that asked for the verdict, or null. */
  trigger: string | null
  action: string
  reason: string
  confidence: number | null
  /** The recommended agent (the dispatch "route"); null when nothing is named. */
  route: string | null
  usage: unknown
  latencyMs: number | null
  answers: unknown
  /** Whether the recommendation actually reached the turn. */
  delivered?: boolean
  [key: string]: unknown
}

/** The host logger shape this plugin uses. */
export interface LoggerLike {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/**
 * Fire-and-forget NDJSON append. A logging failure is a `warn`, never a throw:
 * observability must not be able to break a turn.
 * @param logDir - the configured directory (created on demand).
 * @param record - the verdict row.
 * @param logger - host logger for the failure path.
 */
export async function appendVerdict(logDir: string, record: VerdictRecord, logger?: LoggerLike): Promise<void> {
  try {
    await mkdir(logDir, { recursive: true })
    await appendFile(join(logDir, VERDICT_FILE), `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    logger?.warn?.(`${PLUGIN_NAME}: log write failed: ${String(error)}`)
  }
}

/** A fresh id for one request, so two verdicts on one turn stay distinguishable. */
export function verdictId(): string {
  return randomUUID()
}
