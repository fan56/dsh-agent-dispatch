import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile } from 'node:fs/promises'
import { VERDICT_FILE, appendVerdict, verdictId } from '../lib/index.js'
import { readVerdicts, tempDir } from './helpers.mjs'

const RECORD = {
  at: '2026-09-28T00:00:00.000Z',
  session: 's1',
  mode: 'once',
  trigger: '/dispatch',
  action: 'advise',
  reason: 'dispatch 0.80, workhorse at 0.90',
  confidence: 0.9,
  route: 'workhorse',
  usage: { input_tokens: 100, output_tokens: 20 },
  latencyMs: 412,
  answers: { dispatch: { kind: 'noul', value: 0.8 } },
  delivered: true,
}

test('one NDJSON row per verdict, appended in order', async () => {
  const dir = tempDir('dsh-jev-dispatch-log-')
  try {
    await appendVerdict(dir.dir, { ...RECORD, reason: 'first' })
    await appendVerdict(dir.dir, { ...RECORD, reason: 'second' })
    const rows = await readVerdicts(dir.file(VERDICT_FILE))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].reason, 'first')
    assert.equal(rows[1].reason, 'second')
    assert.equal(rows[0].route, 'workhorse')
    assert.equal(rows[0].delivered, true)
  } finally {
    dir.cleanup()
  }
})

test('the log directory is created on demand', async () => {
  const dir = tempDir('dsh-jev-dispatch-log-')
  try {
    await appendVerdict(`${dir.dir}/nested/deeper`, RECORD)
    assert.equal((await readVerdicts(dir.file('nested/deeper/verdicts.ndjson'))).length, 1)
  } finally {
    dir.cleanup()
  }
})

test('a log failure is a warn, never a throw — observability cannot break a turn', async () => {
  const dir = tempDir('dsh-jev-dispatch-log-')
  try {
    // a regular file where a directory is expected: mkdir fails, append never runs
    await appendFile(dir.file('blocked'), 'not a directory', 'utf8')
    const logs = { warn: [] }
    await appendVerdict(dir.file('blocked'), RECORD, { warn: (m) => logs.warn.push(m) })
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /log write failed/)
  } finally {
    dir.cleanup()
  }
})

test('a failing log with no logger attached still does not throw', async () => {
  const dir = tempDir('dsh-jev-dispatch-log-')
  try {
    await appendFile(dir.file('blocked'), 'not a directory', 'utf8')
    await appendVerdict(dir.file('blocked'), RECORD)
  } finally {
    dir.cleanup()
  }
})

test('verdict ids are unique per request', () => {
  const ids = new Set(Array.from({ length: 50 }, () => verdictId()))
  assert.equal(ids.size, 50)
})
