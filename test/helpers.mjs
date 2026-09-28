/**
 * Shared test fixtures. No mock library, no real network, no real keychain:
 * the host is a hand-built context object, the transport is an injected fetch
 * that answers with strictly-valid System One payloads, and the roster is a
 * real temp directory read through the real loader.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A temp agents directory; removed by the returned cleanup. */
export function tempRosterDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jev-dispatch-roster-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** A temp directory tree for the verdict log. */
export function tempDir(prefix = 'dsh-jev-dispatch-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    file: (name) => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** An agent markdown file with the given frontmatter values. */
export function agentFile({ name, display_name: displayName, description, model, thinking, deep, background, maxRounds, body = '' }) {
  const lines = ['---', `name: ${name}`]
  if (displayName !== undefined) lines.push(`display_name: ${displayName}`)
  if (description !== undefined) lines.push(`description: ${JSON.stringify(description)}`)
  if (model !== undefined) lines.push(`model: ${model}`)
  if (thinking !== undefined) lines.push(`thinking: ${thinking}`)
  if (deep !== undefined) lines.push(`deep: ${deep}`)
  if (background !== undefined) lines.push(`background: ${background}`)
  if (maxRounds !== undefined) lines.push(`maxRounds: ${maxRounds}`)
  lines.push('---', '', body)
  return `${lines.join('\n')}\n`
}

/** Split a probability budget across option names, with `leader` on top. */
function distribution(names, leader, top) {
  const out = {}
  const rest = names.filter((name) => name !== leader)
  if (rest.length === 0) {
    out[leader] = 1
    return out
  }
  const share = (1 - top) / rest.length
  for (const name of rest) out[name] = Number(share.toFixed(4))
  const restSum = Object.values(out).reduce((total, value) => total + value, 0)
  out[leader] = Number((1 - restSum).toFixed(4))
  return out
}

/**
 * An injected fetch that answers one strictly-valid System One payload per
 * call and records every request. `spec` maps question id → noul number, or
 * → `{ pick, probs?, confidence? }` for the choice question.
 */
export function fakeJev(spec = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const answers = {}
    for (const [id, question] of Object.entries(body.questions)) {
      const asked = spec[id]
      if (question.type === 'noul') {
        answers[id] = { noul: typeof asked === 'number' ? asked : 0 }
        continue
      }
      const names = Object.keys(question.criteria)
      const pick = typeof asked === 'string' ? asked : (asked?.pick ?? names[0])
      const probabilities = asked?.probs ?? distribution(names, pick, asked?.top ?? 0.9)
      answers[id] = {
        choice: pick,
        probabilities,
        confidence: asked?.confidence ?? probabilities[pick],
      }
    }
    return new Response(
      JSON.stringify({ answers, model: body.model, usage: { input_tokens: 120, output_tokens: 30 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { fetchImpl, calls }
}

/** A fetch that always fails the way a dead endpoint does. */
export function failingJev(status = 503, body = 'upstream down') {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return new Response(body, { status })
  }
  return { fetchImpl, calls }
}

/** A plain user message, shaped like a DSH one for the fields this plugin reads. */
export function userMessage(text, id = 'm1') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** A message this plugin (or any other producer) injected — never user-authored. */
export function pluginInjected(text, id = 'p1') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-jev-dispatch' } }
}

/** A message builder that records what the plugin tried to inject. */
export function recordingMessageBuilder({ available = true } = {}) {
  const injected = []
  const builder = async (content) => {
    if (!available) return null
    const message = { id: `injected-${injected.length + 1}`, role: 'user', content: [{ type: 'text', text: content }] }
    injected.push(message)
    return message
  }
  builder.injected = injected
  builder.text = () => injected.map((message) => message.content[0].text).join('\n\n')
  return builder
}

/** A hand-built cordis-like context: records listeners, serves services, logs. */
export function fakeCtx({ services = {} } = {}) {
  const listeners = []
  const logs = { info: [], warn: [], error: [] }
  const ctx = {
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
    },
    get: (key) => services[key],
    on: (event, handler, options) => {
      listeners.push({ event, handler, options })
      return () => {}
    },
  }
  ctx.logs = logs
  ctx.listeners = listeners
  ctx.preSteps = () => listeners.filter((entry) => entry.event === 'agent/pre-step')
  /** Drive one pre-step through the waterfall: run `next`, then the listener. */
  ctx.step = async ({ agent, signal, decision }) => {
    const entry = ctx.preSteps()[0]
    if (entry === undefined) throw new Error('no agent/pre-step listener was registered')
    const next = async () => decision
    return await entry.handler({ agent, signal }, next)
  }
  return ctx
}

/** A session/agent pair shaped like the host's. */
export function fakeAgent({ sessionId = 's1', origin = 'user', depth = 0, cwd = '/work/repo' } = {}) {
  return {
    cwd,
    session: { id: sessionId, header: { origin, delegationDepth: depth } },
  }
}

/** Services that satisfy every gate check, with per-part overrides. */
export function workingServices({ maxDepth = 1, toolVisible = true, providerRegistered = true } = {}) {
  return {
    tools: { get: (name) => (toolVisible && name === 'use_agent' ? { name } : undefined) },
    subagents: {
      getProvider: (name) => (providerRegistered && name === 'spawn' ? { name } : undefined),
      resolveMaxDepth: () => maxDepth,
    },
  }
}

/** Deps that keep a test hermetic: no keychain, no closure, no network. */
export function hermeticDeps(overrides = {}) {
  return {
    env: {},
    keychainRunner: () => null,
    apiKey: 'test-key',
    messageBuilder: recordingMessageBuilder(),
    services: workingServices(),
    ...overrides,
  }
}

/** Read NDJSON rows back from a verdict log directory. */
export async function readVerdicts(file) {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** A directory containing no agents at all. */
export function emptyRosterDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jev-dispatch-empty-'))
  return {
    dir,
    agentsDir: join(dir, 'agents'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Materialize a nested temp path that does not exist yet. */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}
