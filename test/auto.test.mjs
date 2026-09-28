/**
 * `mode: 'auto'` — the local keyword gate.
 *
 * The contract under test is asymmetric on purpose: a keyword HIT costs one jev
 * call and behaves like any other verdict, while a MISS is invisible — no call,
 * no injection, no log line, no boot line beyond the one calibration notice.
 * Every test below pins one half of that asymmetry.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, PLUGIN_NAME, resolveConfig } from '../lib/index.js'
import {
  agentFile,
  emptyRosterDir,
  fakeAgent,
  fakeCtx,
  fakeJev,
  hermeticDeps,
  pluginInjected,
  readVerdicts,
  tempDir,
  tempRosterDir,
  userMessage,
  workingServices,
} from './helpers.mjs'

/** The rubric option label of workhorse — jev answers with THIS, not the agent id. */
const WORKHORSE = 'workhorse (牛马狗)'

const ROSTER_FILES = {
  'workhorse.md': agentFile({
    name: 'workhorse',
    display_name: '牛马狗',
    description: '牛马狗：干活的主力。写代码、调查、测试、部署。',
    deep: 0,
  }),
  'oldfox.md': agentFile({
    name: 'oldfox',
    display_name: '老法师',
    description: '老法师：解决难题的顾问。分析、review、审核、挑刺。',
    deep: 0,
  }),
}

/** Mount the plugin in `auto` mode on a fake ctx over a real temp roster. */
function mount({ config = {}, deps = {}, roster = ROSTER_FILES } = {}) {
  const temp = roster === null ? emptyRosterDir() : tempRosterDir(roster)
  const ctx = fakeCtx()
  const merged = hermeticDeps(deps)
  ctx.deps = merged
  apply(ctx, { mode: 'auto', agentsDir: temp.agentsDir ?? temp.dir, ...config }, merged)
  return { ctx, ...temp, deps: merged }
}

const ENTER = (messages) => ({ kind: 'enter', messages })

// ---------------------------------------------------------------- the hit half

test('A: auto classifies a plain turn that hits a Chinese keyword', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE, long_running: 0.9, risky: 0.05 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('帮我实现登录页的失败重试')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(jev.calls.length, 1)
    assert.equal(ctx.deps.messageBuilder.injected.length, 1)
    // appended after every existing message, like the explicit paths
    assert.equal(out.messages.length, 2)
    assert.equal(out.messages[0], decision.messages[0])
    assert.equal(out.messages[1], ctx.deps.messageBuilder.injected[0])
    const text = ctx.deps.messageBuilder.text()
    assert.match(text, /suggest: workhorse \(confidence 0\.90\)/)
    assert.match(text, /task: 帮我实现登录页的失败重试/)
  } finally {
    cleanup()
  }
})

test('B: ASCII keywords are word-bounded — "prefix"/"address" hit nothing', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({
    config: { autoKeywords: ['fix', 'add'], logDir: log.dir },
    deps: { fetch: jev.fetchImpl },
  })
  try {
    const decision = ENTER([userMessage('the prefix of the address is unchanged')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    assert.equal(ctx.logs.info.length, 0)
    assert.equal(ctx.logs.warn.length, 0)
    await assert.rejects(() => readVerdicts(log.file('verdicts.ndjson')), /ENOENT/)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('B2: a word-bounded ASCII hit is case-insensitive, and the log names the first dictionary entry', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({
    config: { autoKeywords: ['fix', 'add'], logDir: log.dir },
    deps: { fetch: jev.fetchImpl },
  })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('Please FIX the address field and ADD a test')]) })
    assert.equal(jev.calls.length, 1)
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.trigger, 'kw:fix')
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('B3: the shipped dictionary matches English task verbs', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('please refactor the timer helper')]) })
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.trigger, 'kw:refactor')
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('L1: the gate reads plain user text only — a keyword inside injected advice does not arm it', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    // the ONLY keyword-bearing text is this plugin's own past advice
    const decision = ENTER([
      pluginInjected('[dsh-agent-dispatch] please fix the flaky timer'),
      userMessage('这个命名怎么样'),
    ])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.logs.info.length, 0)
    await assert.rejects(() => readVerdicts(log.file('verdicts.ndjson')), /ENOENT/)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('L2: a plain turn next to injected advice still drives the gate, and the advice never enters the state', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([
      pluginInjected('[dsh-agent-dispatch] suggest: workhorse'),
      userMessage('请修复登录问题'),
    ])
    await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(jev.calls.length, 1)
    const { state } = jev.calls[0].body
    assert.ok(!state.includes('suggest: workhorse'), 'the plugin\'s own advice never enters the state')
    assert.match(state, /请修复登录问题/)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- the miss half

test('C: a plain turn that hits nothing is completely silent — the point of the gate', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('just a normal question about the weather')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    // logDir is set, so boot printed nothing either: the turn added zero lines
    assert.deepEqual(ctx.logs, { info: [], warn: [], error: [] })
    await assert.rejects(() => readVerdicts(log.file('verdicts.ndjson')), /ENOENT/)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('C2: without a logDir a miss adds nothing on top of the single boot notice', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    assert.equal(ctx.logs.info.length, 1)
    const decision = ENTER([userMessage('just a normal question about the weather')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.logs.info.length, 1)
    assert.equal(ctx.logs.warn.length, 0)
  } finally {
    cleanup()
  }
})

test('D: a keyword hit judged skip injects nothing and prints no line, but is logged', async () => {
  const jev = fakeJev({ dispatch: 0.2 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('请帮我看看这个命名怎么起')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 1)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    assert.equal(ctx.logs.info.filter((line) => /skip —/.test(line)).length, 0)
    assert.equal(ctx.logs.warn.length, 0)
    const rows = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'skip')
    assert.equal(rows[0].mode, 'auto')
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('E: a keyword-turn verdict row is labelled kw:<keyword>', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE, long_running: 0.9, risky: 0.05 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({
      agent: fakeAgent({ sessionId: 'auto-1' }),
      decision: ENTER([userMessage('帮我实现登录页的失败重试')]),
    })
    const rows = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(rows.length, 1)
    const [row] = rows
    assert.equal(row.session, 'auto-1')
    assert.equal(row.mode, 'auto')
    assert.equal(row.trigger, 'kw:帮我')
    assert.equal(row.action, 'advise')
    assert.equal(row.route, 'workhorse')
    assert.equal(row.delivered, true)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('E2: a kw: label is one clean line — CR/LF folded, blanks collapsed, capped at 64 chars', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const log = tempDir('dsh-agent-dispatch-auto-')
  // A user-supplied keyword with a newline and a 70-char head: both the NDJSON
  // line and the label have to survive it.
  const messy = `${'x'.repeat(70)}\nsecond`
  const { ctx, cleanup } = mount({
    config: { autoKeywords: [messy], logDir: log.dir },
    deps: { fetch: jev.fetchImpl },
  })
  try {
    const typed = `${'x'.repeat(70)}  second`
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage(typed)]) })
    assert.equal(jev.calls.length, 1)
    // a raw LF in the label would have split the row and broken the parse
    const rows = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].trigger, `kw:${'x'.repeat(64)}`)
    assert.ok(!/[\r\n]/.test(rows[0].trigger))
    assert.ok(rows[0].trigger.length <= 64 + 3)
    // the gate matched a folded copy; what jev receives is the text as typed
    assert.ok(jev.calls[0].body.state.includes(typed))
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('G: a capability gap on a keyword turn says what is missing ONCE per session, then goes quiet', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({
    config: { logDir: log.dir },
    deps: { fetch: jev.fetchImpl, services: workingServices({ toolVisible: false }) },
  })
  try {
    const decision = ENTER([userMessage('修复登录页的重试逻辑')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    // the diagnostic an explicit turn would get is NOT injected here
    assert.equal(ctx.logs.info.filter((line) => /dispatch unavailable/.test(line)).length, 0)
    // ...but the gap itself is no longer invisible: one line, naming the gap
    assert.equal(ctx.logs.info.length, 1)
    assert.match(ctx.logs.info[0], /use_agent/)
    assert.match(ctx.logs.info[0], /stay silent by design/)
    assert.equal(ctx.logs.warn.length, 0)
    // the second hit repeats nothing — the line is per session, not per turn
    const second = ENTER([userMessage('再修复一次这个测试')])
    const out2 = await ctx.step({ agent: fakeAgent(), decision: second })
    assert.equal(out2, second)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.logs.info.length, 1)
    assert.equal(ctx.logs.warn.length, 0)
    await assert.rejects(() => readVerdicts(log.file('verdicts.ndjson')), /ENOENT/)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('G2: in auto mode the same gap on an explicit request still names what is missing', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({
    config: { logDir: log.dir },
    deps: { fetch: jev.fetchImpl, services: workingServices({ toolVisible: false }) },
  })
  try {
    const out = await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    assert.equal(out.messages.length, 2)
    assert.match(ctx.deps.messageBuilder.text(), /no jev call was made/)
    assert.match(ctx.logs.info.at(-1), /dispatch unavailable/)
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.trigger, '/dispatch')
    assert.equal(row.action, 'unavailable')
  } finally {
    cleanup()
    log.cleanup()
  }
})

// ------------------------------------------------------- the guards, still first

test('H: a subagent session is never classified, even on a keyword turn', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('帮我修复这个测试')])
    const out = await ctx.step({ agent: fakeAgent({ origin: 'subagent' }), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
  } finally {
    cleanup()
  }
})

test('I: an aborted turn short-circuits before the gate', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const controller = new AbortController()
    controller.abort()
    const decision = ENTER([userMessage('帮我修复这个测试')])
    const out = await ctx.step({ agent: fakeAgent(), signal: controller.signal, decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
  } finally {
    cleanup()
  }
})

test('M: once mode never consults autoKeywords — a keyword turn is still untouched', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ config: { mode: 'once', autoKeywords: ['fix'] }, deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('please fix the flaky timer')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
  } finally {
    cleanup()
  }
})

// ------------------------------------------------- explicit semantics, in auto

test('F: an explicit /jev keeps its rendered skip verdict in auto mode', async () => {
  const jev = fakeJev({ dispatch: 0.2 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/jev should this be delegated?')]) })
    assert.equal(jev.calls.length, 1)
    assert.match(ctx.deps.messageBuilder.text(), /Dispatch verdict/)
    assert.match(ctx.deps.messageBuilder.text(), /no delegation/)
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.trigger, '/jev')
    assert.equal(row.action, 'skip')
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('F2: an explicit /dispatch skip stays silent (no render) but is announced, in auto mode too', async () => {
  const jev = fakeJev({ dispatch: 0.2 })
  const log = tempDir('dsh-agent-dispatch-auto-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('/dispatch continue the plan')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    assert.equal(ctx.logs.info.filter((line) => /skip —/.test(line)).length, 1)
  } finally {
    cleanup()
    log.cleanup()
  }
})

// ------------------------------------------------------------------- boot lines

test('J: auto without a logDir says once at boot that the gate cannot be calibrated', () => {
  const temp = tempRosterDir(ROSTER_FILES)
  const log = tempDir('dsh-agent-dispatch-auto-')
  try {
    const autoCtx = fakeCtx()
    apply(autoCtx, { mode: 'auto', agentsDir: temp.dir }, hermeticDeps())
    assert.equal(autoCtx.logs.info.length, 1)
    assert.match(autoCtx.logs.info[0], /auto/)
    assert.match(autoCtx.logs.info[0], /logDir/)

    const onceCtx = fakeCtx()
    apply(onceCtx, { mode: 'once', agentsDir: temp.dir }, hermeticDeps())
    assert.equal(onceCtx.logs.info.filter((line) => line.includes('logDir')).length, 0)
    assert.equal(onceCtx.logs.info.length, 0)

    const loggedCtx = fakeCtx()
    apply(loggedCtx, { mode: 'auto', agentsDir: temp.dir, logDir: log.dir }, hermeticDeps())
    assert.equal(loggedCtx.logs.info.length, 0)
  } finally {
    temp.cleanup()
    log.cleanup()
  }
})

test('J2: the auto notice sits after the key check — no key still means exactly one line', () => {
  const ctx = fakeCtx()
  apply(ctx, { mode: 'auto' }, hermeticDeps({ apiKey: undefined, env: { TYPESAFE_API_KEY: '' } }))
  assert.equal(ctx.preSteps().length, 0)
  assert.equal(ctx.logs.info.length, 1)
  assert.match(ctx.logs.info[0], /no jev key configured/)
  assert.equal(ctx.logs.warn.length, 0)
  assert.equal(ctx.logs.error.length, 0)
})

// ------------------------------------------------------------------- validation

test('K: auto with an empty keyword gate fails the load loudly and leaves the plugin inert', () => {
  assert.throws(() => resolveConfig({ mode: 'auto', autoKeywords: [] }), /autoKeywords/)
  const ctx = fakeCtx()
  apply(ctx, { mode: 'auto', autoKeywords: [] }, hermeticDeps())
  assert.equal(ctx.preSteps().length, 0)
  assert.equal(ctx.logs.error.length, 1)
  assert.match(ctx.logs.error[0], new RegExp(PLUGIN_NAME))
  assert.match(ctx.logs.error[0], /autoKeywords/)
})
