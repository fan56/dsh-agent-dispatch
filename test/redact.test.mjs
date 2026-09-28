import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUILT_IN_REDACT_PATTERNS, buildState, isPlainUserMessage, messageText, redact, taskExcerpt, userTurnTexts } from '../lib/index.js'
import { pluginInjected, userMessage } from './helpers.mjs'

test('credential shapes are replaced before anything leaves', () => {
  const secrets = [
    'sk-abcdefghij0123456789ABCDEFGH',
    'pk_live_abcdefghij0123456789',
    'ghp_abcdefghij0123456789ABCDEFGHIJ',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'api_key=super-secret-value',
    'password: hunter2hunter2',
  ]
  for (const secret of secrets) {
    const out = redact(`before ${secret} after`)
    assert.ok(!out.includes(secret), `not redacted: ${secret}`)
    assert.match(out, /\[redacted\]/)
  }
})

test('a long base64 blob is redacted, a short identifier is not', () => {
  assert.match(redact(`x ${'A1b2C3d4'.repeat(6)} y`), /\[redacted\]/)
  assert.equal(redact('commit 1a2b3c4d'), 'commit 1a2b3c4d')
})

test('user patterns extend the built-in set, and a broken pattern is skipped', () => {
  const out = redact('ticket ACME-12345 failed', ['ACME-\\d+'])
  assert.equal(out, 'ticket [redacted] failed')
  assert.equal(redact('anything', ['(']), 'anything')
})

test('messageText reads text parts and ignores everything else', () => {
  assert.equal(messageText(userMessage('hello')), 'hello')
  assert.equal(messageText({ content: 'plain' }), 'plain')
  assert.equal(messageText({ content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'a' }] }), 'a')
  assert.equal(messageText(null), '')
  assert.equal(messageText({}), '')
})

test('plugin-authored messages are not user turns', () => {
  assert.equal(isPlainUserMessage(userMessage('hi')), true)
  assert.equal(isPlainUserMessage(pluginInjected('[dsh-jev-dispatch] advice')), false)
  assert.equal(isPlainUserMessage({ role: 'assistant', content: 'hi' }), false)
})

test('the state carries only plain user text, the task first, and the workspace', () => {
  const state = buildState(
    [userMessage('first'), pluginInjected('previous verdict'), userMessage('second')],
    '/work/repo',
    1200,
  )
  assert.match(state, /^workspace: \/work\/repo\ntask:\n/)
  assert.ok(state.includes('first') && state.includes('second'))
  assert.ok(!state.includes('previous verdict'))
})

test('an explicit request leads the state so the cap can never drop it', () => {
  const state = buildState([userMessage('and some context')], '/work/repo', 1200, [], 'fix the flaky e2e timer')
  assert.ok(state.includes('task:\nfix the flaky e2e timer'))
})

test('redaction runs on the whole assembly, including the workspace path', () => {
  const state = buildState([userMessage('deploy with api_key=abcdef123456')], '/work/sk-abcdefghij0123456789ABCDEFGH', 1200)
  assert.ok(!state.includes('sk-abcdefghij0123456789ABCDEFGH'))
  assert.ok(!state.includes('abcdef123456'))
})

test('the cap applies to the redacted whole, from the head', () => {
  const long = 'z'.repeat(5000)
  const state = buildState([userMessage(long)], '/work/repo', 200)
  assert.equal(state.length, 200)
  assert.ok(!state.includes('sk-'))
})

test('a turn with nothing user-authored produces no state at all', () => {
  assert.equal(buildState([], '/work/repo', 1200), '')
  assert.equal(buildState([pluginInjected('advice only')], '/work/repo', 1200), '')
  assert.equal(buildState([userMessage('   ')], '/work/repo', 1200), '')
})

test('userTurnTexts drops empties and trims', () => {
  assert.deepEqual(userTurnTexts([userMessage(' a '), userMessage('  '), pluginInjected('b')]), ['a'])
})

test('taskExcerpt prefers the request text, falls back to the last turn, and is bounded', () => {
  assert.equal(taskExcerpt([userMessage('later context')], 'do the thing'), 'do the thing')
  assert.equal(taskExcerpt([userMessage('old'), userMessage('latest turn')], ''), 'latest turn')
  const long = taskExcerpt([], 'q'.repeat(500))
  assert.equal(long.length, 201)
  assert.ok(long.endsWith('…'))
  assert.equal(taskExcerpt([], ''), '')
})

test('taskExcerpt is redacted like everything else outbound', () => {
  assert.match(taskExcerpt([userMessage('use sk-abcdefghij0123456789ABCDEFGH now')], ''), /\[redacted\]/)
})

test('the built-in pattern set is stable', () => {
  assert.equal(BUILT_IN_REDACT_PATTERNS.length, 8)
})
