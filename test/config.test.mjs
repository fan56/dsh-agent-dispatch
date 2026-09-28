import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_THRESHOLDS,
  PLUGIN_NAME,
  PLUGIN_SOURCE_KIND,
  loggingEnabled,
  mergeDefaults,
  resolveConfig,
  validate,
} from '../lib/index.js'

test('defaults ship off, silent, and unlogged', () => {
  const config = resolveConfig()
  assert.equal(config.mode, 'off')
  assert.equal(config.logDir, null)
  assert.equal(loggingEnabled(config), false)
  assert.equal(config.skipSubagentSessions, true)
  assert.deepEqual(config.triggers, ['/dispatch', '/jev'])
  assert.equal(config.toolName, 'use_agent')
  assert.equal(config.provider, 'spawn')
  // The README claimed 2000 for three releases after the code moved to 5000;
  // this assertion is what makes that drift impossible to repeat silently.
  assert.equal(config.timeoutMs, 5_000)
})

test('thresholds are the System One calibration values, each independently overridable', () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, {
    dispatchRecommend: 0.6,
    dispatchSkip: 0.35,
    agentConfidence: 0.7,
    agentMargin: 0.15,
    risky: 0.75,
    longRunning: 0.7,
  })
  const config = resolveConfig({ mode: 'once', thresholds: { agentMargin: 0.3 } })
  assert.equal(config.thresholds.agentMargin, 0.3)
  // every other threshold keeps its default
  assert.equal(config.thresholds.dispatchRecommend, 0.6)
  assert.equal(config.thresholds.risky, 0.75)
})

test('thresholds deep-merge without dropping sibling keys', () => {
  const merged = mergeDefaults({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 9, z: 3 } })
  assert.deepEqual(merged, { a: 1, nested: { x: 1, y: 9, z: 3 } })
})

test('arrays and scalars replace rather than merge', () => {
  const config = resolveConfig({ triggers: ['/route'] })
  assert.deepEqual(config.triggers, ['/route'])
  assert.equal(config.toolName, 'use_agent')
})

test('a config with no thresholds object still gets the full set', () => {
  const config = resolveConfig({ mode: 'once' })
  assert.deepEqual(config.thresholds, { ...DEFAULT_THRESHOLDS })
})

test('validation accepts auto and still rejects an unknown mode', () => {
  assert.equal(resolveConfig({ mode: 'auto' }).mode, 'auto')
  // The anchored "$" is load-bearing: an unanchored /off, once/ keeps matching
  // the new "off, once, auto" message, so a prefix match here is a false green.
  assert.throws(() => resolveConfig({ mode: 'sometimes' }), /mode must be one of off, once, auto$/)
})

test('autoKeywords default to the shipped bilingual dictionary, non-empty by construction', () => {
  const config = resolveConfig()
  assert.ok(Array.isArray(config.autoKeywords))
  assert.ok(config.autoKeywords.length > 0)
  // every shipped entry is non-empty, and the dictionary is task intent, never single characters
  assert.ok(config.autoKeywords.every((keyword) => typeof keyword === 'string' && keyword.length > 1))
  assert.ok(config.autoKeywords.includes('修复'))
  assert.ok(config.autoKeywords.includes('fix'))
  assert.ok(config.autoKeywords.includes('help me'))
})

test('auto mode refuses an empty keyword gate — a mode that could never fire', () => {
  assert.throws(() => resolveConfig({ mode: 'auto', autoKeywords: [] }), /mode "auto" requires a non-empty autoKeywords/)
  // the same list is inert outside auto, so it is not an error there
  assert.deepEqual(resolveConfig({ mode: 'once', autoKeywords: [] }).autoKeywords, [])
  assert.throws(() => resolveConfig({ autoKeywords: 'fix' }), /autoKeywords must be an array of non-empty strings/)
  assert.throws(() => resolveConfig({ autoKeywords: ['ok', ''] }), /autoKeywords must be an array of non-empty strings/)
})

test('validation rejects triggers that are not slash commands', () => {
  assert.throws(() => resolveConfig({ triggers: ['dispatch'] }), /"\/command" strings/)
  assert.throws(() => resolveConfig({ triggers: [] }), /non-empty array/)
})

test('validation rejects thresholds outside [0, 1]', () => {
  assert.throws(() => resolveConfig({ thresholds: { risky: 1.5 } }), /thresholds.risky must be a probability/)
  assert.throws(() => resolveConfig({ thresholds: { agentMargin: -0.1 } }), /thresholds.agentMargin must be a probability/)
})

test('validation rejects an inverted dispatch band', () => {
  assert.throws(
    () => resolveConfig({ thresholds: { dispatchSkip: 0.9, dispatchRecommend: 0.5 } }),
    /must not exceed/,
  )
})

test('validation rejects a log directory that is neither a path nor empty', () => {
  assert.throws(() => resolveConfig({ logDir: 42 }), /logDir must be a directory path/)
  assert.equal(loggingEnabled(resolveConfig({ logDir: '' })), false)
  assert.equal(loggingEnabled(resolveConfig({ logDir: '/tmp/verdicts' })), true)
})

test('validation rejects non-string redact patterns', () => {
  assert.throws(() => resolveConfig({ redactPatterns: [42] }), /array of regex source strings/)
})

test('validate returns the same object it checked', () => {
  const config = resolveConfig()
  assert.equal(validate(config), config)
})

test('the plugin stamps its own message source kind', () => {
  assert.equal(PLUGIN_NAME, 'dsh-agent-dispatch')
  assert.equal(PLUGIN_SOURCE_KIND, 'plugin:dsh-agent-dispatch')
})
