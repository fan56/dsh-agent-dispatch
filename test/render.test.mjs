import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderAdvice, renderHold, renderSkip, renderToolCall, renderUnavailable } from '../lib/index.js'

const OPTIONS = { toolName: 'use_agent', task: 'fix the flaky e2e timer', includeDismissLine: true }

const ADVISE = {
  action: 'advise',
  reason: 'dispatch 0.80, workhorse at 0.90',
  confidence: 0.9,
  agent: 'workhorse',
  flags: { background: true },
  answers: { dispatch: { kind: 'noul', value: 0.8 } },
  model: 'jev-1.13.0',
  usage: null,
  latencyMs: 1,
}

test('the advice is four compact lines: agent + in-band confidence, task, use_agent call, dismiss line', () => {
  const lines = renderAdvice(ADVISE, OPTIONS).split('\n')
  assert.equal(lines.length, 5) // banner + four
  assert.match(lines[0], /^\[dsh-agent-dispatch\] Dispatch suggestion/)
  assert.match(lines[1], /^- suggest: workhorse \(confidence 0\.90\)$/)
  assert.equal(lines[2], '- task: fix the flaky e2e timer')
  assert.match(lines[3], /^- use: use_agent\(\{ agent: "workhorse", prompt: .*background: true \}\)$/)
  assert.match(lines[4], /ignore it and carry on/)
})

test('a short task carries no background flag', () => {
  const line = renderAdvice({ ...ADVISE, flags: {} }, OPTIONS).split('\n')[3]
  assert.equal(line.includes('background'), false)
  assert.match(line, /agent: "workhorse"/)
})

test('the advice never names a model, a resume, or a fresh flag', () => {
  const rendered = renderAdvice(ADVISE, OPTIONS)
  assert.ok(!/model/i.test(rendered))
  assert.ok(!/resume/.test(rendered))
  assert.ok(!/fresh/.test(rendered))
  // the only keys the call line can carry are agent, prompt and background
  const call = /use_agent\(\{ ([\s\S]*) \}\)/.exec(rendered)[1]
  assert.deepEqual(['agent', 'prompt', 'background'].filter((key) => call.includes(`${key}: `)).sort(), ['agent', 'background', 'prompt'])
  assert.equal(call.includes('"workhorse"'), true)
})

test('the dismiss line is optional', () => {
  const lines = renderAdvice(ADVISE, { ...OPTIONS, includeDismissLine: false }).split('\n')
  assert.equal(lines.length, 4)
})

test('an empty task excerpt still renders four lines', () => {
  const lines = renderAdvice(ADVISE, { ...OPTIONS, task: '' }).split('\n')
  assert.equal(lines.length, 5)
  assert.match(lines[2], /no task text in this turn/)
})

test('renderToolCall quotes the agent name and orders the flags last', () => {
  assert.equal(
    renderToolCall({ toolName: 'use_agent', agent: 'old fox', background: false }),
    'use_agent({ agent: "old fox", prompt: "<self-contained brief: goal, exact files or APIs in scope, acceptance checks>" })',
  )
})

test('the hold message tells the agent to keep the work and confirm the risky step', () => {
  const lines = renderHold({ ...ADVISE, action: 'hold', agent: null, flags: {} }, OPTIONS).split('\n')
  assert.equal(lines.length, 5)
  assert.match(lines[0], /Dispatch held back/)
  assert.match(lines[1], /hard to undo \(confidence 0\.90\)/)
  assert.match(lines[3], /do NOT hand this to a subagent/)
})

test('the free-request skip still shows the verdict and the dispatch probability', () => {
  const text = renderSkip({ ...ADVISE, action: 'skip', agent: null, flags: {}, reason: 'uncertain' }, OPTIONS)
  const lines = text.split('\n')
  assert.match(lines[1], /^- verdict: no delegation — uncertain$/)
  assert.match(lines[3], /^- dispatch probability: 0\.80$/)
})

test('the unavailable diagnostic names every gap and stays advice-free', () => {
  const text = renderUnavailable(['the dispatch tool "use_agent" is not visible to this agent', 'no agent is registered'])
  const lines = text.split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0], /no jev call was made/)
  assert.match(lines[1], /"use_agent" is not visible/)
  assert.match(lines[2], /no agent is registered/)
  assert.match(lines[3], /re-run the request/)
})

test('every injected message is attributed to this plugin', () => {
  const messages = [
    renderAdvice(ADVISE, OPTIONS),
    renderHold(ADVISE, OPTIONS),
    renderSkip(ADVISE, OPTIONS),
    renderUnavailable(['x']),
  ]
  for (const message of messages) {
    assert.ok(message.startsWith('[dsh-agent-dispatch] '))
  }
})
