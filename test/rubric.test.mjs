import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_AGENT, QUESTION_IDS, agentOptions, buildQuestions, criteriaLines, findTrigger, parseAgentMarkdown, resolvePick } from '../lib/index.js'
import { agentFile, pluginInjected, userMessage } from './helpers.mjs'

/** A roster snapshot in the shape the rubric reads it. */
function rosterOf(files, dir = '/agents') {
  const agents = []
  for (const [file, text] of Object.entries(files)) {
    const parsed = parseAgentMarkdown(text, `${dir}/${file}`)
    assert.equal(parsed.ok, true, file)
    agents.push(parsed.agent)
  }
  return { agents, broken: [] }
}

const TRIGGERS = ['/dispatch', '/jev']

test('a trigger must start a plain user turn', () => {
  assert.equal(findTrigger([], TRIGGERS), null)
  assert.equal(findTrigger([userMessage('please /dispatch this')], TRIGGERS), null)
  assert.equal(findTrigger([pluginInjected('/dispatch something')], TRIGGERS), null)
  assert.equal(findTrigger([userMessage('   ')], TRIGGERS), null)
  assert.equal(findTrigger(null, TRIGGERS), null)
})

test('the trigger table: each word, its kind, and the task it carries', () => {
  assert.deepEqual(findTrigger([userMessage('/dispatch 修 flaky e2e')], TRIGGERS), {
    kind: 'dispatch',
    task: '修 flaky e2e',
    trigger: '/dispatch',
  })
  assert.deepEqual(findTrigger([userMessage('/jev should this be delegated?')], TRIGGERS), {
    kind: 'jev',
    task: 'should this be delegated?',
    trigger: '/jev',
  })
})

test('a bare trigger is a valid request with an empty task', () => {
  assert.deepEqual(findTrigger([userMessage('/jev')], TRIGGERS), { kind: 'jev', task: '', trigger: '/jev' })
})

test('a trigger is case-insensitive and word-bounded', () => {
  assert.equal(findTrigger([userMessage('/DISPATCH now')], TRIGGERS).trigger, '/dispatch')
  assert.equal(findTrigger([userMessage('/jevis museum')], TRIGGERS), null)
  assert.equal(findTrigger([userMessage('/dispatch-ish')], TRIGGERS), null)
  // punctuation and end-of-line both close the word
  assert.notEqual(findTrigger([userMessage('/jev, please')], TRIGGERS), null)
  assert.notEqual(findTrigger([userMessage('/jev!')], TRIGGERS), null)
})

test('the first turn carrying a trigger wins, and only one call is made per turn', () => {
  const trigger = findTrigger([userMessage('/dispatch first'), userMessage('/jev second')], TRIGGERS)
  assert.equal(trigger.trigger, '/dispatch')
  assert.equal(trigger.task, 'first')
})

test('custom triggers are honored and unknown kinds get the free-request semantics', () => {
  const trigger = findTrigger([userMessage('/route it')], ['/route'])
  assert.deepEqual(trigger, { kind: 'jev', task: 'it', trigger: '/route' })
  // a configured trigger list can drop the built-ins entirely
  assert.equal(findTrigger([userMessage('/dispatch it')], ['/route']), null)
})

test('roster entries become the agent choice options, none last', () => {
  const { criteria, agentByOption } = agentOptions(rosterOf([
    agentFile({ name: 'workhorse', display_name: '牛马狗', description: '牛马狗：干活的主力。写代码、调查、测试。', deep: 0 }),
    agentFile({ name: 'oldfox', display_name: '老法师', description: '老法师：顾问。分析、review、审核。', deep: 0 }),
  ], '/agents'))
  assert.deepEqual(Object.keys(criteria), ['workhorse (牛马狗)', 'oldfox (老法师)', NO_AGENT])
  assert.equal(criteria['workhorse (牛马狗)'], '牛马狗：干活的主力。写代码、调查、测试。 [leaf]')
  assert.match(criteria[NO_AGENT], /No registered agent fits better/)
  // the option label is a rubric name; the agent id is what use_agent takes
  assert.deepEqual(agentByOption, { 'workhorse (牛马狗)': 'workhorse', 'oldfox (老法师)': 'oldfox', none: 'none' })
})

test('the option descriptions are exactly the rendered roster lines', () => {
  const roster = rosterOf([agentFile({ name: 'boss', display_name: '老板', description: '老板：拍板的人。方案与取舍都归他拍，细节他不管。', deep: 2, maxRounds: 30 })], '/agents')
  const { criteria } = agentOptions(roster)
  assert.deepEqual(criteriaLines(roster), ['- boss (老板): 老板：拍板的人。方案与取舍都归他拍，细节他不管。 · rounds cap 30'])
  assert.equal(criteria['boss (老板)'], '老板：拍板的人。方案与取舍都归他拍，细节他不管。 · rounds cap 30')
})

test('an agent without a display name is its own label and its own id', () => {
  const { criteria, agentByOption } = agentOptions(rosterOf([agentFile({ name: 'boss', description: 'The boss decides things.' })], '/agents'))
  assert.deepEqual(Object.keys(criteria), ['boss', NO_AGENT])
  assert.equal(agentByOption['boss'], 'boss')
})

test('resolvePick translates a label to an agent id and refuses everything else', () => {
  const options = agentOptions(rosterOf([agentFile({ name: 'workhorse', display_name: '牛马狗', description: '牛马狗：干活的主力，写代码。' })], '/agents'))
  assert.equal(resolvePick('workhorse (牛马狗)', options), 'workhorse')
  assert.equal(resolvePick(NO_AGENT, options), null)
  assert.equal(resolvePick(null, options), null)
  assert.equal(resolvePick('someone-else', options), null)
})

test('the rubric asks exactly the four atomic questions, each with two-sided noul criteria', () => {
  const questions = buildQuestions(agentOptions(rosterOf({
    'workhorse.md': agentFile({ name: 'workhorse', display_name: '牛马狗', description: '牛马狗：干活的主力。写代码、调查。' }),
  })).criteria)
  assert.deepEqual(Object.keys(questions), [...QUESTION_IDS])
  for (const id of ['dispatch', 'risky', 'long_running']) {
    assert.equal(questions[id].type, 'noul', id)
    assert.ok(questions[id].instructions.length > 0)
    assert.ok(questions[id].criteria.true.length > 0)
    assert.ok(questions[id].criteria.false.length > 0)
  }
  assert.equal(questions.agent.type, 'choice')
  assert.ok(questions.agent.criteria[NO_AGENT].length > 0)
})

test('the rubric never asks for effort, blast radius, or a model', () => {
  const body = JSON.stringify(buildQuestions(agentOptions(rosterOf({
    'a.md': agentFile({ name: 'a', description: 'An agent that does a specific thing well.' }),
  })).criteria))
  assert.ok(!body.includes('effort'))
  assert.ok(!body.includes('blast_radius'))
  assert.ok(!body.includes('"model"'))
})
