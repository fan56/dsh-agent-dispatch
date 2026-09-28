import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, PLUGIN_NAME } from '../lib/index.js'
import {
  agentFile,
  emptyRosterDir,
  failingJev,
  fakeAgent,
  fakeCtx,
  fakeJev,
  hermeticDeps,
  pluginInjected,
  readVerdicts,
  recordingMessageBuilder,
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
    model: 'xiaomi-token-plan-cn/mimo-v2.6-flash',
  }),
  'oldfox.md': agentFile({
    name: 'oldfox',
    display_name: '老法师',
    description: '老法师：解决难题的顾问。分析、review、审核、挑刺。',
    deep: 0,
  }),
}

/** Mount the plugin on a fake ctx over a real temp roster. */
function mount({ config = {}, deps = {}, roster = ROSTER_FILES } = {}) {
  const temp = roster === null ? emptyRosterDir() : tempRosterDir(roster)
  const ctx = fakeCtx()
  const merged = hermeticDeps(deps)
  ctx.deps = merged
  apply(ctx, { mode: 'once', agentsDir: temp.agentsDir ?? temp.dir, ...config }, merged)
  return { ctx, ...temp, deps: merged }
}

const ENTER = (messages) => ({ kind: 'enter', messages })

test('mode off registers nothing and says one thing', () => {
  const ctx = fakeCtx()
  apply(ctx, {}, hermeticDeps())
  assert.equal(ctx.preSteps().length, 0)
  assert.equal(ctx.logs.info.length, 1)
  assert.match(ctx.logs.info[0], /mode off; not listening/)
  assert.equal(ctx.logs.warn.length, 0)
})

test('jev-optional leg: no key configured is exactly mode off — one info, no listener, no warnings', () => {
  const ctx = fakeCtx()
  apply(ctx, { mode: 'once' }, hermeticDeps({ apiKey: undefined, env: { TYPESAFE_API_KEY: '' } }))
  assert.equal(ctx.preSteps().length, 0)
  assert.equal(ctx.logs.info.length, 1)
  assert.match(ctx.logs.info[0], /no jev key configured/)
  assert.equal(ctx.logs.warn.length, 0)
  assert.equal(ctx.logs.error.length, 0)
})

test('a key in the environment is enough — the keychain leg is only one source', () => {
  const ctx = fakeCtx()
  apply(ctx, { mode: 'once' }, hermeticDeps({ apiKey: undefined, env: { JEV_API_KEY: 'from-env' } }))
  assert.equal(ctx.preSteps().length, 1)
  assert.deepEqual(ctx.preSteps()[0].options, { prepend: true })
})

test('a broken config is loud and leaves the plugin inert', () => {
  const ctx = fakeCtx()
  apply(ctx, { mode: 'sometimes' }, hermeticDeps())
  assert.equal(ctx.preSteps().length, 0)
  assert.equal(ctx.logs.error.length, 1)
  assert.match(ctx.logs.error[0], new RegExp(PLUGIN_NAME))
})

test('the listener joins the waterfall prepended, so its message lands last', () => {
  const { ctx, cleanup } = mount()
  try {
    assert.equal(ctx.preSteps().length, 1)
    assert.equal(ctx.preSteps()[0].event, 'agent/pre-step')
    assert.deepEqual(ctx.preSteps()[0].options, { prepend: true })
  } finally {
    cleanup()
  }
})

test('a rejected step is returned untouched — no call, no message', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = { kind: 'reject' }
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
  } finally {
    cleanup()
  }
})

test('an aborted turn is returned untouched', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const controller = new AbortController()
    controller.abort()
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), signal: controller.signal, decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
  } finally {
    cleanup()
  }
})

test('an ordinary turn is silent: no call, no message, no log', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const log = tempDir('dsh-agent-dispatch-plugin-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('just a normal question')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    await assert.rejects(() => readVerdicts(log.file('verdicts.ndjson')))
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('a subagent session is never advised, even when it asks', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent({ origin: 'subagent' }), decision })
    assert.equal(out, decision)
    assert.equal(jev.calls.length, 0)
  } finally {
    cleanup()
  }
})

test('an explicit dispatch request advises and appends after every existing message', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE, long_running: 0.9, risky: 0.05 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const existing = [userMessage('context first'), userMessage('/dispatch 修 flaky e2e')]
    const decision = ENTER(existing)
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.notEqual(out, decision)
    assert.notEqual(out.messages, existing)
    assert.equal(out.messages.length, 3)
    assert.equal(out.messages[0], existing[0])
    assert.equal(out.messages[1], existing[1])
    assert.equal(out.messages[2], ctx.deps.messageBuilder.injected[0])
    const text = ctx.deps.messageBuilder.text()
    assert.match(text, /suggest: workhorse \(confidence 0\.90\)/)
    assert.match(text, /background: true/)
    assert.match(text, /task: 修 flaky e2e/)
  } finally {
    cleanup()
  }
})

test('the advice names the agent id use_agent takes, not the rubric label', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const log = tempDir('dsh-agent-dispatch-plugin-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    const text = ctx.deps.messageBuilder.text()
    assert.match(text, /- suggest: workhorse \(confidence/)
    assert.ok(!text.includes('\u725b\u9a6c\u72d7'), 'the display name is a rubric label, not a callable id')
    assert.match(text, /use_agent\(\{ agent: "workhorse"/)
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.route, 'workhorse')
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('one call per request, carrying the four-question rubric built from the live roster', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    assert.equal(jev.calls.length, 1)
    const body = jev.calls[0].body
    assert.deepEqual(Object.keys(body.questions), ['dispatch', 'agent', 'risky', 'long_running'])
    const options = Object.keys(body.questions.agent.criteria)
    assert.deepEqual(options, ['oldfox (老法师)', 'workhorse (牛马狗)', 'none'])
    assert.match(body.questions.agent.criteria['workhorse (牛马狗)'], /干活的主力/)
    // the composed model is never part of the criteria
    assert.ok(!JSON.stringify(body.questions).includes('mimo-v2.6-flash'))
    assert.equal(body.model, 'jev-1.13.0')
  } finally {
    cleanup()
  }
})

test('the state on the wire is redacted and capped', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({ config: { stateChars: 200 }, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch deploy with api_key=supersecretvalue123')]) })
    const { state } = jev.calls[0].body
    assert.ok(!state.includes('supersecretvalue123'))
    assert.ok(state.length <= 200)
    assert.match(state, /^workspace: \/work\/repo\ntask:\ndeploy with \[redacted\]/)
  } finally {
    cleanup()
  }
})

test('a dispatch request whose verdict is a skip injects nothing', async () => {
  const jev = fakeJev({ dispatch: 0.2 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('/dispatch continue the plan')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    assert.match(ctx.logs.info.at(-1), /skip — dispatch 0\.20 <= 0\.35/)
  } finally {
    cleanup()
  }
})

test('a /jev request shows the verdict even when it recommends nothing', async () => {
  const jev = fakeJev({ dispatch: 0.2 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/jev should this be delegated?')]) })
    assert.match(ctx.deps.messageBuilder.text(), /Dispatch verdict/)
    assert.match(ctx.deps.messageBuilder.text(), /no delegation/)
  } finally {
    cleanup()
  }
})

test('a risky task is held back with an explicit do-not-delegate line', async () => {
  const jev = fakeJev({ dispatch: 0.9, agent: WORKHORSE, risky: 0.9 })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch migrate production')]) })
    const text = ctx.deps.messageBuilder.text()
    assert.match(text, /Dispatch held back/)
    assert.match(text, /do NOT hand this to a subagent/)
    assert.ok(!text.includes('suggest: workhorse'))
  } finally {
    cleanup()
  }
})

test('the capability gate is re-probed per request and reports exactly what is missing', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const builder = recordingMessageBuilder()
  const { ctx, cleanup } = mount({
    deps: { fetch: jev.fetchImpl, services: workingServices({ toolVisible: false }), messageBuilder: builder },
  })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out.messages.length, 2)
    const text = builder.text()
    assert.match(text, /no jev call was made/)
    assert.match(text, /"use_agent" is not visible to this agent/)
    assert.equal(jev.calls.length, 0)
  } finally {
    cleanup()
  }
})

test('an empty roster blocks the call and says so', async () => {
  const jev = fakeJev({ dispatch: 0.9 })
  const { ctx, cleanup } = mount({ roster: null, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    assert.match(ctx.deps.messageBuilder.text(), /no agent is registered/)
    assert.equal(jev.calls.length, 0)
  } finally {
    cleanup()
  }
})

test('an unavailable gate writes a verdict row so the gap is measurable', async () => {
  const log = tempDir('dsh-agent-dispatch-plugin-')
  const { ctx, cleanup } = mount({
    config: { logDir: log.dir },
    deps: { services: workingServices({ providerRegistered: false }) },
  })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    const rows = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'unavailable')
    assert.match(rows[0].reason, /subagent provider "spawn" is not registered/)
    assert.equal(rows[0].route, null)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('fail-open: a jev failure passes the turn through and stays quiet', async () => {
  const jev = failingJev(503, 'upstream down')
  const log = tempDir('dsh-agent-dispatch-plugin-')
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
    // degradation is silence: no warning is ever printed for a failed call
    assert.equal(ctx.logs.warn.length, 0)
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.action, 'error')
    assert.match(row.reason, /jev endpoint returned HTTP 503/)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('fail-open: a strictly-invalid response is a typed error, also fail-open', async () => {
  const log = tempDir('dsh-agent-dispatch-plugin-')
  const { ctx, cleanup } = mount({
    config: { logDir: log.dir },
    deps: {
      // answers only one of the four questions: the core rejects it outright
      fetch: async () => new Response(JSON.stringify({ answers: { dispatch: { noul: 0.9 } } }), { status: 200 }),
    },
  })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(ctx.logs.warn.length, 0)
    const [row] = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(row.action, 'error')
    assert.match(row.reason, /failed strict validation/)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('a verdict log row records the pick, the confidence, the answers and the delivery', async () => {
  const log = tempDir('dsh-agent-dispatch-plugin-')
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE, long_running: 0.9 })
  const { ctx, cleanup } = mount({ config: { logDir: log.dir }, deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent({ sessionId: 'sess-7' }), decision: ENTER([userMessage('/dispatch fix it')]) })
    const rows = await readVerdicts(log.file('verdicts.ndjson'))
    assert.equal(rows.length, 1)
    const [row] = rows
    assert.equal(row.session, 'sess-7')
    assert.equal(row.mode, 'once')
    assert.equal(row.trigger, '/dispatch')
    assert.equal(row.action, 'advise')
    assert.equal(row.route, 'workhorse')
    assert.equal(row.confidence, 0.9)
    assert.equal(row.delivered, true)
    assert.deepEqual(row.usage, { input_tokens: 120, output_tokens: 30 })
    assert.equal(typeof row.latencyMs, 'number')
    assert.equal(row.answers.dispatch.value, 0.85)
    assert.ok(row.id && row.at)
  } finally {
    cleanup()
    log.cleanup()
  }
})

test('nothing is logged when no log directory is configured', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    assert.equal(ctx.deps.messageBuilder.injected.length, 1)
    // no logDir was configured, so the write path was never taken at all
    assert.equal(ctx.logs.warn.length, 0)
  } finally {
    cleanup()
  }
})

test('a missing message factory skips the injection instead of fabricating one', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl, messageBuilder: recordingMessageBuilder({ available: false }) } })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(ctx.logs.warn.length, 1)
    assert.match(ctx.logs.warn[0], /skipping injection instead of fabricating a message/)
  } finally {
    cleanup()
  }
})

test('a turn cancelled while the call is in flight injects nothing', async () => {
  const controller = new AbortController()
  const jev = {
    calls: 0,
    fetchImpl: async () => {
      jev.calls += 1
      controller.abort()
      return new Response(JSON.stringify({ answers: {} }), { status: 500 })
    },
  }
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), signal: controller.signal, decision })
    assert.equal(out, decision)
    assert.equal(ctx.deps.messageBuilder.injected.length, 0)
  } finally {
    cleanup()
  }
})

test('an unexpected internal failure still returns the turn', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({
    deps: {
      fetch: jev.fetchImpl,
      // a message factory that explodes: nothing may reach the turn
      messageBuilder: async () => { throw new Error('factory exploded') },
    },
  })
  try {
    const decision = ENTER([userMessage('/dispatch fix it')])
    const out = await ctx.step({ agent: fakeAgent(), decision })
    assert.equal(out, decision)
    assert.equal(ctx.logs.warn.length, 1)
    assert.match(ctx.logs.warn[0], /unexpected failure, turn proceeds without advice/)
  } finally {
    cleanup()
  }
})

test('the plugin never re-classifies its own past advice', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const { ctx, cleanup } = mount({ deps: { fetch: jev.fetchImpl } })
  try {
    const decision = ENTER([pluginInjected('[dsh-agent-dispatch] suggest: workhorse'), userMessage('/dispatch real request')])
    await ctx.step({ agent: fakeAgent(), decision })
    const { state } = jev.calls[0].body
    assert.ok(!state.includes('suggest: workhorse'))
    assert.match(state, /real request/)
  } finally {
    cleanup()
  }
})

test('the configured tool name flows into the advice line, not a hardcoded one', async () => {
  const jev = fakeJev({ dispatch: 0.85, agent: WORKHORSE })
  const services = { tools: { get: (name) => (name === 'dispatch_agent' ? {} : undefined) }, subagents: workingServices().subagents }
  const { ctx, cleanup } = mount({ config: { toolName: 'dispatch_agent' }, deps: { fetch: jev.fetchImpl, services } })
  try {
    await ctx.step({ agent: fakeAgent(), decision: ENTER([userMessage('/dispatch fix it')]) })
    assert.match(ctx.deps.messageBuilder.text(), /dispatch_agent\(\{ agent: "workhorse"/)
  } finally {
    cleanup()
  }
})
