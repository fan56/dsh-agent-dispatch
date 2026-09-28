import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_DESCRIPTION_CHARS,
  MIN_DESCRIPTION_CHARS,
  agentsDir,
  boundDescription,
  criteriaDescription,
  criteriaLines,
  dshHome,
  expandHome,
  firstSentence,
  loadRoster,
  parseAgentMarkdown,
  resolveAgentsDir,
  sanitizeDescription,
} from '../lib/index.js'
import { agentFile, emptyRosterDir, tempRosterDir } from './helpers.mjs'

test('frontmatter parses with the registry field set', () => {
  const result = parseAgentMarkdown(agentFile({
    name: 'workhorse',
    display_name: '牛马狗',
    description: '干活的主力。写代码、调查、测试、部署。',
    model: 'opencode-go/deepseek-v4-flash',
    thinking: 'high',
    deep: 0,
    background: 'false',
    maxRounds: 60,
    body: 'You are 牛马狗',
  }), '/agents/workhorse.md')
  assert.equal(result.ok, true)
  assert.deepEqual(result.agent.meta, {
    name: 'workhorse',
    deep: 0,
    displayName: '牛马狗',
    description: '干活的主力。写代码、调查、测试、部署。',
    model: 'opencode-go/deepseek-v4-flash',
    thinking: 'high',
    background: false,
    maxRounds: 60,
  })
  assert.equal(result.agent.body, 'You are 牛马狗')
})

test('deep defaults to 1 and unknown keys are ignored, not capabilities', () => {
  const result = parseAgentMarkdown('---\nname: a\nextensions: ["*", "gate"]\n---\nbody\n', '/a.md')
  assert.equal(result.ok, true)
  assert.equal(result.agent.meta.deep, 1)
  assert.equal(result.agent.meta.extensions, undefined)
})

test('a file without frontmatter or a name is broken', () => {
  assert.match(parseAgentMarkdown('no frontmatter here', '/a.md').error, /missing frontmatter/)
  assert.match(parseAgentMarkdown('---\ndescription: x\n---\n', '/a.md').error, /missing required frontmatter key `name`/)
})

test('strict fields fail loud: thinking, background, maxRounds, deep', () => {
  const cases = [
    ['---\nname: a\nthinking: extreme\n---\n', /invalid `thinking`/],
    ['---\nname: a\nbackground: True\n---\n', /invalid `background`/],
    ['---\nname: a\nmaxRounds: 0\n---\n', /invalid `maxRounds`/],
    ['---\nname: a\ndeep: -1\n---\n', /invalid `deep`/],
  ]
  for (const [text, pattern] of cases) {
    assert.equal(parseAgentMarkdown(text, '/a.md').ok, false, text)
    assert.match(parseAgentMarkdown(text, '/a.md').error, pattern)
  }
})

test('a broken file never reaches the criteria — the whole file is dropped', async () => {
  const roster = tempRosterDir({
    'good.md': agentFile({ name: 'good', description: 'A perfectly usable description of this agent.' }),
    'broken.md': '---\nname: broken\nthinking: extreme\n---\n',
  })
  try {
    const loaded = await loadRoster(roster.dir)
    assert.deepEqual(loaded.agents.map((a) => a.meta.name), ['good'])
    assert.deepEqual(loaded.broken.map((b) => b.path.split('/').pop()), ['broken.md'])
    const lines = criteriaLines(loaded)
    assert.equal(lines.length, 2)
    assert.match(lines[1], /unparsable agents excluded: broken\.md/)
    // basenames only: an absolute host path is noise inside a rubric criterion
    assert.ok(!lines[1].includes(roster.dir))
  } finally {
    roster.cleanup()
  }
})

test('the roster is read fresh, sorted, and never cached across edits', async () => {
  const roster = tempRosterDir({
    'zeta.md': agentFile({ name: 'zeta', description: 'The zzz agent does zzz things well.' }),
  })
  try {
    const first = await loadRoster(roster.dir)
    assert.deepEqual(first.agents.map((a) => a.meta.name), ['zeta'])
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(roster.dir, 'alpha.md'), agentFile({ name: 'alpha', description: 'The aaa agent does aaa things well.' }), 'utf8')
    const second = await loadRoster(roster.dir)
    assert.deepEqual(second.agents.map((a) => a.meta.name), ['alpha', 'zeta'])
  } finally {
    roster.cleanup()
  }
})

test('a missing agents directory is an empty roster, not an error', async () => {
  const home = emptyRosterDir()
  try {
    const loaded = await loadRoster(home.agentsDir)
    assert.deepEqual(loaded, { agents: [], broken: [] })
  } finally {
    home.cleanup()
  }
})

test('sanitizeDescription strips YAML leaks and folds whitespace', () => {
  // a YAML block scalar leaks the escaped quote and an unescaped `>` between CJK
  assert.equal(sanitizeDescription('\\\\"牛马狗>干活的主力。写代码\\"'), '牛马狗干活的主力。写代码')
  assert.equal(sanitizeDescription('"quoted"'), 'quoted')
  assert.equal(sanitizeDescription("'quoted'"), 'quoted')
  assert.equal(sanitizeDescription('multi\n  line\ttext'), 'multi line text')
  assert.equal(sanitizeDescription(''), '')
})

test('boundDescription keeps the first sentence, then hard-cuts at the cap', () => {
  assert.equal(boundDescription('short enough'), 'short enough')
  assert.equal(boundDescription(`${'a'.repeat(200)}`), 'a'.repeat(MAX_DESCRIPTION_CHARS))
  // a first sentence that fits the cap is kept whole, and the rest is dropped
  const twoSentences = `${'x'.repeat(60)}. ${'y'.repeat(200)}`
  assert.equal(boundDescription(twoSentences), `${'x'.repeat(60)}.`)
  // a CJK terminator is a sentence end too
  assert.equal(boundDescription(`${'字'.repeat(60)}。${'字'.repeat(100)}`), `${'字'.repeat(60)}。`)
  // a first sentence longer than the cap cannot be kept whole: the cap wins
  assert.equal(boundDescription(`${'x'.repeat(140)}. ${'y'.repeat(140)}`), 'x'.repeat(MAX_DESCRIPTION_CHARS))
})

test('description fallback chain: frontmatter → body → display name → name', () => {
  const rich = {
    path: '/a.md',
    meta: { name: 'a', deep: 0, displayName: 'A', description: 'A description long enough to be used as is.' },
    body: 'Body first sentence. Second sentence.',
  }
  assert.equal(criteriaDescription(rich), rich.meta.description)

  const thin = { path: '/b.md', meta: { name: 'b', deep: 0, displayName: 'B', description: 'too short' }, body: 'The body explains this agent properly and at length. More text.' }
  assert.equal(criteriaDescription(thin), 'The body explains this agent properly and at length.')

  const bodyless = { path: '/c.md', meta: { name: 'c', deep: 0, displayName: 'C', description: 'tiny' }, body: '' }
  assert.equal(criteriaDescription(bodyless), 'C')

  const bare = { path: '/d.md', meta: { name: 'd', deep: 0 }, body: '' }
  assert.equal(criteriaDescription(bare), 'd')
})

test('a thin description below the floor falls through to the body sentence', () => {
  const meta = { name: 'e', deep: 1, description: 'x'.repeat(MIN_DESCRIPTION_CHARS - 1) }
  const line = criteriaDescription({ path: '/e.md', meta, body: 'The real explanation lives in the body text here.' })
  assert.equal(line, 'The real explanation lives in the body text here.')
})

test('a long description is bounded but keeps its first sentence', () => {
  const meta = { name: 'f', deep: 1, description: `${'x'.repeat(60)}. ${'second'.repeat(60)}` }
  const line = criteriaDescription({ path: '/f.md', meta, body: '' })
  assert.equal(line, `${'x'.repeat(60)}.`)
})

test('criteria lines carry the roster line shape and short metadata, never a model', () => {
  const lines = criteriaLines({
    agents: [
      {
        path: '/workhorse.md',
        meta: { name: 'workhorse', deep: 0, displayName: '牛马狗', description: '牛马狗：干活的主力。写代码、调查、测试、部署。', model: 'xiaomi/mimo-v2.6-flash' },
        body: 'x',
      },
      { path: '/boss.md', meta: { name: 'boss', deep: 2, maxRounds: 40 }, body: 'x' },
    ],
    broken: [],
  })
  assert.match(lines[0], /^- workhorse \(牛马狗\): 牛马狗：干活的主力。写代码、调查、测试、部署。 \[leaf\]$/)
  assert.match(lines[1], /^- boss: boss · rounds cap 40$/)
  // the frontmatter model is parsed for strictness parity, never surfaced
  assert.ok(!lines.join('\n').includes('xiaomi/mimo-v2.6-flash'))
})

test('firstSentence always cuts at the first sentence end within the cap', () => {
  assert.equal(firstSentence('One. Two.'), 'One.')
  assert.equal(firstSentence('One. Two.', 4), 'One.')
  assert.equal(firstSentence('no terminator here at all'), 'no terminator here at all')
  assert.equal(firstSentence('一。二。'), '一。')
})

test('dsh home resolution honors DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: '/custom/home' }), '/custom/home')
  assert.equal(dshHome({ HOME: '/home/u' }), '/home/u/.dsh')
  assert.equal(agentsDir({ DSH_HOME: '/custom/home' }), '/custom/home/agents')
  assert.equal(expandHome('~/x', { HOME: '/home/u' }), '/home/u/x')
  assert.equal(expandHome('/abs', { HOME: '/home/u' }), '/abs')
  // the default literal resolves against the dsh home; a custom path is verbatim
  assert.equal(resolveAgentsDir('~/.dsh/agents', { DSH_HOME: '/custom/home' }), '/custom/home/agents')
  assert.equal(resolveAgentsDir('~/agents', { HOME: '/home/u' }), '/home/u/agents')
  assert.equal(resolveAgentsDir('/etc/agents', {}), '/etc/agents')
})
