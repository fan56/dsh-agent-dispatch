import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THRESHOLDS, decide, failed } from '../lib/index.js'

const THRESHOLDS = { ...DEFAULT_THRESHOLDS }

/** A classified result shaped exactly like the core returns it. */
function result(overrides = {}) {
  const {
    dispatch = 0.8,
    pick = 'workhorse',
    probs,
    risky = 0.1,
    longRunning = 0.1,
    ...rest
  } = overrides
  return {
    answers: {
      dispatch: { kind: 'noul', value: dispatch },
      agent: {
        kind: 'choice',
        value: pick,
        probabilities: probs ?? { workhorse: 0.9, oldfox: 0.05, none: 0.05 },
        confidence: 0.9,
      },
      risky: { kind: 'noul', value: risky },
      long_running: { kind: 'noul', value: longRunning },
      ...rest.answers,
    },
    model: 'jev-1.13.0',
    usage: { input_tokens: 100, output_tokens: 20 },
    latencyMs: 412,
  }
}

function context(overrides = {}) {
  return { thresholds: THRESHOLDS, capabilities: { sessionDepth: 0, maxDepth: 1 }, deepByAgent: { workhorse: 0, oldfox: 0 }, ...overrides }
}

test('a clear yes with a clear pick advises, and carries the classify metadata through', () => {
  const verdict = decide(result(), context())
  assert.equal(verdict.action, 'advise')
  assert.equal(verdict.agent, 'workhorse')
  assert.equal(verdict.confidence, 0.9)
  assert.deepEqual(verdict.flags, {})
  assert.equal(verdict.model, 'jev-1.13.0')
  assert.equal(verdict.latencyMs, 412)
  assert.deepEqual(verdict.usage, { input_tokens: 100, output_tokens: 20 })
})

test('the dispatch band: at or above the recommendation line advises, at or below the skip line skips', () => {
  assert.equal(decide(result({ dispatch: 0.6 }), context()).action, 'advise')
  assert.equal(decide(result({ dispatch: 0.59 }), context()).action, 'skip')
  const low = decide(result({ dispatch: 0.35 }), context())
  assert.equal(low.action, 'skip')
  assert.match(low.reason, /0\.35 <= 0\.35 \(do it here\)/)
  const high = decide(result({ dispatch: 0.36 }), context())
  assert.equal(high.action, 'skip')
  assert.match(high.reason, /uncertain/)
})

test('the middle of the band is uncertainty, not weak evidence', () => {
  const verdict = decide(result({ dispatch: 0.5 }), context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /uncertain \(< 0\.6\)/)
  assert.equal(verdict.agent, null)
})

test('a missing dispatch answer skips rather than defaulting to yes', () => {
  const verdict = decide({ ...result(), answers: { agent: result().answers.agent } }, context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /dispatch answer missing/)
})

test('risky at or above the veto line holds the delegation back', () => {
  const verdict = decide(result({ risky: 0.75 }), context())
  assert.equal(verdict.action, 'hold')
  assert.equal(verdict.agent, null)
  assert.match(verdict.reason, /risky 0\.75 >= 0\.75/)
  // below the line it never fires, even in the middle of the band
  assert.equal(decide(result({ risky: 0.74 }), context()).action, 'advise')
  assert.equal(decide(result({ risky: 0.5 }), context()).action, 'advise')
})

test('a risky task that needs no delegation anyway just skips — the veto upgrades a yes, it does not invent one', () => {
  const verdict = decide(result({ risky: 0.95, dispatch: 0.1 }), context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /do it here/)
})

test('the none option is a first-class answer, not a fallback', () => {
  const verdict = decide(result({ pick: 'none', probs: { workhorse: 0.05, oldfox: 0.05, none: 0.9 } }), context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /declined to name an agent/)
})

test('agent confidence gates at its line', () => {
  const at = { ...result(), answers: { ...result().answers, agent: { kind: 'choice', value: 'workhorse', probabilities: { workhorse: 0.7, oldfox: 0.15, none: 0.15 }, confidence: 0.7 } } }
  assert.equal(decide(at, context()).action, 'advise')
  const below = { ...at, answers: { ...at.answers, agent: { ...at.answers.agent, confidence: 0.69 } } }
  const verdict = decide(below, context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /agent confidence 0\.69 < 0\.7/)
})

test('the top1−top2 margin over AGENTS gates the pick; none is not a rival candidate', () => {
  const tied = result({ probs: { workhorse: 0.5, oldfox: 0.45, none: 0.05 } })
  const verdict = decide(tied, context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /agent margin 0\.05 < 0\.15 \(top two look alike\)/)

  const clear = result({ probs: { workhorse: 0.65, oldfox: 0.3, none: 0.05 } })
  assert.equal(decide(clear, context()).action, 'advise')

  // a large `none` mass does not count toward the margin, but it does shrink
  // the winning probability — which the confidence floor already catches
  const abstaining = result({ probs: { workhorse: 0.7, oldfox: 0.05, none: 0.25 } })
  assert.equal(decide(abstaining, context()).action, 'advise')
})

test('no probabilities means no margin to check — the pick is not trusted blind', () => {
  const blind = { ...result(), answers: { ...result().answers, agent: { kind: 'choice', value: 'workhorse', probabilities: null, confidence: 0.95 } } }
  const verdict = decide(blind, context())
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /no margin to check/)
})

test('a missing agent answer skips', () => {
  const partial = { ...result(), answers: { dispatch: { kind: 'noul', value: 0.9 } } }
  assert.match(decide(partial, context()).reason, /agent answer missing/)
})

test('long-running work carries background:true at its line, and only that flag', () => {
  assert.deepEqual(decide(result({ longRunning: 0.7 }), context()).flags, { background: true })
  assert.deepEqual(decide(result({ longRunning: 0.69 }), context()).flags, {})
  assert.deepEqual(decide(result({ longRunning: 0.5 }), context()).flags, {})
  // v1 emits no other flag, so it can never produce the mutually exclusive
  // background+resume pair use_agent rejects
  const flags = decide(result({ longRunning: 0.99 }), context()).flags
  assert.deepEqual(Object.keys(flags), ['background'])
})

test('a pick that does not fit the depth budget is dropped after the call, not injected', () => {
  const verdict = decide(result(), context({
    capabilities: { sessionDepth: 1, maxDepth: 1 },
    deepByAgent: { workhorse: 1 },
  }))
  assert.equal(verdict.action, 'skip')
  assert.match(verdict.reason, /depth: the pick needs delegation depth 3/)
})

test('a leaf pick at the same depth still fits', () => {
  const verdict = decide(result(), context({
    capabilities: { sessionDepth: 0, maxDepth: 1 },
    deepByAgent: { workhorse: 0 },
  }))
  assert.equal(verdict.action, 'advise')
})

test('every threshold is independently honored by the policy', () => {
  const loose = { ...THRESHOLDS, dispatchRecommend: 0.4 }
  assert.equal(decide(result({ dispatch: 0.45 }), context({ thresholds: loose })).action, 'advise')
  const strict = { ...THRESHOLDS, agentMargin: 0.6 }
  assert.equal(decide(result({ probs: { workhorse: 0.7, oldfox: 0.2, none: 0.1 } }), context({ thresholds: strict })).action, 'skip')
  const noRisk = { ...THRESHOLDS, risky: 0.99 }
  assert.equal(decide(result({ risky: 0.9 }), context({ thresholds: noRisk })).action, 'advise')
})

test('the unjudgeable failures share the verdict shape', () => {
  for (const action of ['error', 'unavailable']) {
    const verdict = failed(action, 'because')
    assert.equal(verdict.action, action)
    assert.equal(verdict.reason, 'because')
    assert.deepEqual(verdict.answers, {})
    assert.equal(verdict.agent, null)
    assert.deepEqual(verdict.flags, {})
  }
})
