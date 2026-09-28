import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDispatchCapabilities, depthConflict, isSubagentSession, sessionDepthOf } from '../lib/index.js'
import { fakeAgent, workingServices } from './helpers.mjs'

const CONFIG = { toolName: 'use_agent', provider: 'spawn' }
const ROSTER = { agents: [{ meta: { name: 'workhorse' } }], broken: [] }
const EMPTY_ROSTER = { agents: [], broken: [] }

test('all four satisfied: the gate opens', () => {
  const report = checkDispatchCapabilities(workingServices(), fakeAgent(), CONFIG, ROSTER)
  assert.deepEqual(report.missing, [])
  assert.equal(report.ok, true)
  assert.equal(report.sessionDepth, 0)
  assert.equal(report.maxDepth, 1)
})

test('leg 1: the dispatch tool must be visible to THIS agent', () => {
  const report = checkDispatchCapabilities(workingServices({ toolVisible: false }), fakeAgent(), CONFIG, ROSTER)
  assert.equal(report.ok, false)
  assert.equal(report.missing.length, 1)
  assert.match(report.missing[0], /"use_agent" is not visible to this agent/)
  assert.ok(!/subagent_fork/.test(report.missing[0]))
})

test('leg 1 probes the configured tool name, not a hardcoded one', () => {
  const services = { tools: { get: (name) => (name === 'dispatch_agent' ? { name } : undefined) }, subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1 } }
  const report = checkDispatchCapabilities(services, fakeAgent(), { toolName: 'dispatch_agent', provider: 'spawn' }, ROSTER)
  assert.equal(report.ok, true)
})

test('leg 2: the subagent provider must be registered', () => {
  const report = checkDispatchCapabilities(workingServices({ providerRegistered: false }), fakeAgent(), CONFIG, ROSTER)
  assert.equal(report.ok, false)
  assert.match(report.missing[0], /subagent provider "spawn" is not registered/)
})

test('leg 3: an empty roster blocks — there is nobody to dispatch to', () => {
  const report = checkDispatchCapabilities(workingServices(), fakeAgent(), CONFIG, EMPTY_ROSTER)
  assert.equal(report.ok, false)
  assert.match(report.missing[0], /no agent is registered/)
})

test('leg 4: an exhausted depth budget blocks', () => {
  const report = checkDispatchCapabilities(workingServices({ maxDepth: 0 }), fakeAgent(), CONFIG, ROSTER)
  assert.equal(report.ok, false)
  assert.match(report.missing[0], /delegation depth is exhausted/)
})

test('missing services are reported, not thrown on', () => {
  const report = checkDispatchCapabilities(undefined, undefined, CONFIG, ROSTER)
  assert.equal(report.ok, false)
  // tool + provider; the roster is fine and an absent maxDepth is unknown, not zero
  assert.equal(report.missing.length, 2)
  assert.equal(report.sessionDepth, 0)
  assert.equal(report.maxDepth, null)
})

test('a service that throws is a gap, never an exception', () => {
  const services = {
    tools: { get: () => { throw new Error('scope is gone') } },
    subagents: { getProvider: () => { throw new Error('no such provider') }, resolveMaxDepth: () => { throw new Error('nope') } },
  }
  const report = checkDispatchCapabilities(services, fakeAgent(), CONFIG, ROSTER)
  assert.equal(report.ok, false)
  assert.equal(report.maxDepth, null)
})

test('an unreported maxDepth is unknown, not zero — a host without the getter is not a host without delegation', () => {
  const services = { tools: workingServices().tools, subagents: { getProvider: () => ({}) } }
  const report = checkDispatchCapabilities(services, fakeAgent(), CONFIG, ROSTER)
  assert.equal(report.ok, true)
  assert.equal(report.maxDepth, null)
  assert.equal(depthConflict(report, 0), null)
  assert.equal(depthConflict(report, 5), null)
})

test('session depth is the max of the persisted header and the runtime option', () => {
  assert.equal(sessionDepthOf(fakeAgent()), 0)
  assert.equal(sessionDepthOf(fakeAgent({ depth: 2 })), 2)
  assert.equal(sessionDepthOf({ session: { header: { delegationDepth: 3 } }, options: { subagentDepth: 1 } }), 3)
  assert.equal(sessionDepthOf({ options: { subagentDepth: 4 } }), 4)
  assert.equal(sessionDepthOf(undefined), 0)
})

test('the per-agent depth refinement fits session + 1 + the agent own deep', () => {
  const report = { ok: true, missing: [], sessionDepth: 0, maxDepth: 1 }
  assert.equal(depthConflict(report, 0), null)
  assert.match(depthConflict(report, 1), /needs delegation depth 2 .* but the host allows 1/)
  const deepSession = { ok: true, missing: [], sessionDepth: 1, maxDepth: 2 }
  assert.equal(depthConflict(deepSession, 0), null)
  assert.match(depthConflict(deepSession, 2), /needs delegation depth 4/)
})

test('subagent sessions are recognized from the session header origin', () => {
  assert.equal(isSubagentSession(fakeAgent()), false)
  assert.equal(isSubagentSession(fakeAgent({ origin: 'subagent' })), true)
  assert.equal(isSubagentSession(undefined), false)
})
