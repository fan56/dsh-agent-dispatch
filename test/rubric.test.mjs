import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_AGENT, QUESTION_IDS, agentOptions, buildQuestions, criteriaLines, findKeyword, findTrigger, parseAgentMarkdown, resolvePick } from '../lib/index.js'
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

// ------------------------------------------------ the local auto keyword gate

/**
 * One row per gate decision: [what it pins, turn text, dictionary, expected
 * hit]. The gate is the only thing standing between an ordinary turn and a jev
 * call, so each row is a semantic claim about which turns are worth one.
 */
const KEYWORD_CASES = [
  // Word boundaries: letters, digits, and underscore are word characters.
  ['fix inside prefix is not a word', 'the prefix is unchanged', ['fix'], null],
  ['add inside address is not a word', 'update the address field now', ['add'], null],
  ['add inside addressing is not a word', 'addressing the flaky test', ['add'], null],
  ['fix_it is one identifier, not a word', 'please fix_it now', ['fix'], null],
  ['a hyphen separates words', 'please fix-me now', ['fix'], 'fix'],
  ['a hyphen separates words in front of the keyword', 'the e2e-test is red', ['test'], 'test'],
  ['punctuation separates words', 'fix, then ship it', ['fix'], 'fix'],
  // One common inflection is allowed after an ASCII stem.
  ['fixing is the same verb as fix', 'fixing the timer', ['fix'], 'fix'],
  ['fixed is the same verb as fix', 'fixed the bug', ['fix'], 'fix'],
  ['tests is the same noun as test', 'run the tests', ['test'], 'test'],
  ['deployment is the same noun as deploy', 'deployment is broken', ['deploy'], 'deploy'],
  ['refactoring is the same verb as refactor', 'refactoring the auth module', ['refactor'], 'refactor'],
  // `d` is in the suffix set because an `-e` stem + `ed` is NOT the stem + `ed`:
  // the plain `ed` alternative spells "removeed", so every one of these verbs
  // was a silent miss before `d` joined the set.
  ['removed is the past tense of remove', 'removed the stale flag', ['remove'], 'remove'],
  ['deleted is the past tense of delete', 'deleted the branch', ['delete'], 'delete'],
  ['updated is the past tense of update', 'updated the config', ['update'], 'update'],
  ['generated is the past tense of generate', 'generated the client', ['generate'], 'generate'],
  ['migrated is the past tense of migrate', 'migrated the schema', ['migrate'], 'migrate'],
  ['upgraded is the past tense of upgrade', 'upgraded the dependency', ['upgrade'], 'upgrade'],
  ['replaced is the past tense of replace', 'replaced the timer', ['replace'], 'replace'],
  ['reproduced is the past tense of reproduce', 'reproduced the failure', ['reproduce'], 'reproduce'],
  ['investigated is the past tense of investigate', 'investigated the leak', ['investigate'], 'investigate'],
  ['optimized is the past tense of optimize', 'optimized the query', ['optimize'], 'optimize'],
  ['analysed is the past tense of analyse', 'analysed the trace', ['analyse'], 'analyse'],
  ['diagnosed is the past tense of diagnose', 'diagnosed the hang', ['diagnose'], 'diagnose'],
  // ...and `d` must not open a malformed match: `address` still misses `add`.
  ['the d suffix does not make address hit add', 'updated the address field', ['add'], null],
  ['analysis is shipped as its own entry', 'analysis is wrong', ['analysis'], 'analysis'],
  // CJK next to Latin: a Chinese entry matches as a substring, even glued to a word.
  ['a Chinese keyword matches with Latin right after it', '帮我fix一下', ['帮我'], '帮我'],
  ['the Chinese entry wins on dictionary order, not on the ASCII path', '帮我fix一下', ['帮我', 'fix'], '帮我'],
  // Whitespace folding and NFKC apply to the matching copy only.
  ['repeated spaces fold to one', 'help  me please', ['help me'], 'help me'],
  ['a newline folds to a space', 'help\nme please', ['help me'], 'help me'],
  // A multi-word entry treats punctuation between its words as a separator.
  ['a comma separates the words of an entry', 'help,me please', ['help me'], 'help me'],
  ['a hyphen separates the words of an entry', 'help-me please', ['help me'], 'help me'],
  ['the letters of one word are not a separator', 'helpXme please', ['help me'], null],
  ['full-width Latin folds to ASCII', 'ｆｉｘ this bug', ['fix'], 'fix'],
  ['a full-width space folds like any other', 'ｆｉｘ　this bug', ['fix'], 'fix'],
  // User config may be regex-shaped; it must be escaped, never compiled.
  ['a regex-shaped keyword is escaped', 'a label (b) here', ['(b)'], '(b)'],
  ['an anchored-looking keyword is escaped', 'it costs $5+ now', ['$5+'], '$5+'],
  ['the same keyword does not hit a different amount', 'it costs $5 now', ['$5+'], null],
  ['a multi-word keyword is matched as one phrase', 'x a b y', ['a b'], 'a b'],
  // Known tradeoff, pinned so it is not "fixed" by accident: the suffix is
  // appended to the LAST word of a multi-word entry, so a one-letter last word
  // lets the following word's first letter pose as a suffix. This is why the
  // shipped dictionary no longer carries `write a` (it was unreachable dead
  // weight behind `write` anyway).
  ['a one-letter last word lets the next word pose as a suffix', 'write as much as you like', ['write a'], 'write a'],
]

test('the keyword gate table: boundaries, inflections, folding, escapes', () => {
  for (const [name, text, keywords, expected] of KEYWORD_CASES) {
    const hit = findKeyword([userMessage(text)], keywords)
    assert.equal(hit === null ? null : hit.keyword, expected, name)
  }
})

test('the shipped dictionary covers the -e past tense and the irregular forms', async () => {
  const { DEFAULT_AUTO_KEYWORDS } = await import('../lib/index.js')
  // Every one of these was a silent miss before `d` joined the suffix set (the
  // `ed` alternative spells "removeed") or before the irregular form shipped.
  // The hit reports the DICTIONARY ENTRY (the stem), not the surface form.
  const inflected = [
    ['removed', 'remove'], ['deleted', 'delete'], ['updated', 'update'], ['generated', 'generate'],
    ['running', 'running'], ['committed', 'committed'], ['verified', 'verified'],
  ]
  for (const [word, entry] of inflected) {
    const hit = findKeyword([userMessage(`please ${word} it`)], DEFAULT_AUTO_KEYWORDS)
    assert.equal(hit === null ? null : hit.keyword, entry, word)
  }
  // The widened suffix set must not leak into the documented counterexamples.
  assert.equal(findKeyword([userMessage('prefix, address, suffix')], DEFAULT_AUTO_KEYWORDS), null)
})

test('the shipped dictionary dropped the dead-weight write a entry', async () => {
  const { DEFAULT_AUTO_KEYWORDS } = await import('../lib/index.js')
  // `write a` was unreachable: `write` sits earlier in the dictionary and
  // matches every turn a `write a` entry could, so the only thing the entry
  // could ever do was let "write as much as you like" forge a `kw:write a`
  // label via the one-letter-last-word suffix path. The phrase still clears the
  // gate — through `write`, which is the honest label for it.
  assert.equal(DEFAULT_AUTO_KEYWORDS.includes('write a'), false)
  assert.deepEqual(findKeyword([userMessage('write as much as you like')], DEFAULT_AUTO_KEYWORDS), { keyword: 'write' })
})

test('the gate keeps message order ahead of dictionary order (first hit wins)', () => {
  // The dictionary is deliberately in the opposite order: a dictionary-first
  // scan would answer "deploy" for a turn whose FIRST message says "fix".
  const messages = [userMessage('please fix the timer'), userMessage('then deploy it')]
  assert.deepEqual(findKeyword(messages, ['deploy', 'fix']), { keyword: 'fix' })
  // Within ONE message the dictionary decides.
  assert.deepEqual(findKeyword([userMessage('fix and deploy it')], ['deploy', 'fix']), { keyword: 'deploy' })
})

test('the gate reads plain user text only, and skips malformed dictionary entries', () => {
  assert.equal(findKeyword([pluginInjected('[dsh-agent-dispatch] suggest: workhorse — 部署 the fix')], ['部署', 'fix']), null)
  assert.equal(findKeyword([userMessage('   ')], ['fix']), null)
  assert.equal(findKeyword([], ['fix']), null)
  assert.equal(findKeyword(null, ['fix']), null)
  assert.deepEqual(findKeyword([userMessage('fix it')], [123, '', 'fix']), { keyword: 'fix' })
})

test('the gate never mutates the text it matched', () => {
  const text = 'ｆｉｘ  the\nTimer  now'
  const message = userMessage(text)
  assert.deepEqual(findKeyword([message], ['fix']), { keyword: 'fix' })
  assert.equal(message.content[0].text, text)
})

test('a Chinese substring hit inside a longer word is a known tradeoff, not a bug', () => {
  // 修复面膜 ("repair mask") hits 修复 ("repair"): Chinese has no word
  // boundaries, so substring matching is the only cheap rule available, and the
  // alternative (segmenting) costs more than the occasional false hit. This test
  // exists so the behavior is not "fixed" by accident later.
  assert.deepEqual(findKeyword([userMessage('修复面膜怎么用')], ['修复']), { keyword: '修复' })
})
