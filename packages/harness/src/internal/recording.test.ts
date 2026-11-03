import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { NormalizedFile, NormalizedRun } from '@provino/types'
import { HarnessError, type HarnessErrorCode } from '../errors.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { assertNoPathLeak, assertRunComplete, commitGolden } from './recording.ts'

function rejects(code: HarnessErrorCode, ...mentions: string[]): (error: unknown) => boolean {
  return (error) =>
    error instanceof HarnessError &&
    error.code === code &&
    mentions.every((text) => error.message.includes(text))
}

const complete = makeRun([
  makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])]),
  makeFile('b.test.ts', [makeTest('b.test.ts', ['u'], { status: 'failed' })]),
])

test('a run with every expected file, each with tests, is complete', () => {
  assertRunComplete(complete, ['a.test.ts', 'b.test.ts'], 'area/thing (jest)')
})

test('a missing or an unexpected result file is HARNESS_RUN_INCOMPLETE and names the file', () => {
  assert.throws(
    () => assertRunComplete(complete, ['a.test.ts', 'b.test.ts', 'c.test.ts'], 'area/thing (jest)'),
    rejects('HARNESS_RUN_INCOMPLETE', 'area/thing (jest)', 'c.test.ts', 'missing'),
  )
  assert.throws(
    () => assertRunComplete(complete, ['a.test.ts'], 'area/thing (jest)'),
    rejects('HARNESS_RUN_INCOMPLETE', 'b.test.ts', 'unexpected'),
  )
})

test('a crashed file is incomplete and carries its normalized fileError message', () => {
  const crashed: NormalizedFile = {
    file: 'a.test.ts',
    status: 'crashed',
    tests: [],
    fileError: {
      message: "● Test suite failed to run\n\nCannot find module './x' from 'a.test.ts'",
      raw: '',
    },
  }
  assert.throws(
    () => assertRunComplete(makeRun([crashed]), ['a.test.ts'], 'f (jest)'),
    rejects('HARNESS_RUN_INCOMPLETE', 'a.test.ts', 'crashed', "Cannot find module './x'"),
  )
})

test('a file with no tests is incomplete', () => {
  assert.throws(
    () => assertRunComplete(makeRun([makeFile('a.test.ts', [], 'passed')]), ['a.test.ts'], 'f'),
    rejects('HARNESS_RUN_INCOMPLETE', 'a.test.ts', 'no tests'),
  )
})

test('run errors make a run incomplete and are quoted', () => {
  const run: NormalizedRun = {
    ...complete,
    runErrors: [{ message: 'Jest: a worker crashed', raw: '' }],
  }
  assert.throws(
    () => assertRunComplete(run, ['a.test.ts', 'b.test.ts'], 'f'),
    rejects('HARNESS_RUN_INCOMPLETE', 'run error', 'Jest: a worker crashed'),
  )
})

test('every problem is listed in one error', () => {
  const run = makeRun([makeFile('a.test.ts', [], 'passed')], {
    runErrors: [{ message: 'boom', raw: '' }],
  })
  assert.throws(
    () => assertRunComplete(run, ['a.test.ts', 'z.test.ts'], 'f'),
    rejects('HARNESS_RUN_INCOMPLETE', 'z.test.ts', 'no tests', 'boom'),
  )
})

test('assertNoPathLeak passes clean text and names the path it found', () => {
  assertNoPathLeak('{"message": "<root>/a.test.ts:3:4"}', ['/work/dir', '/Users/me'], 'f (jest)')
  assert.throws(
    () =>
      assertNoPathLeak(
        '{"userFrame": "/Users/me/proj/x.ts:1:2"}',
        ['/work/dir', '/Users/me'],
        'f (jest)',
      ),
    rejects('HARNESS_GOLDEN_LEAKS_PATH', 'f (jest)', '/Users/me'),
  )
})

test('assertNoPathLeak ignores empty and root-only paths, and sees JSON-escaped Windows paths', () => {
  assertNoPathLeak('{"a": "/x/y"}', ['', '/', '\\'], 'f')
  assert.throws(
    () => assertNoPathLeak('{"a": "C:\\\\Users\\\\me\\\\x.ts"}', ['C:\\Users\\me'], 'f'),
    rejects('HARNESS_GOLDEN_LEAKS_PATH', 'C:\\Users\\me'),
  )
})

async function withTempDir(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-recording-'))
  try {
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('commitGolden writes a new golden, then reports it unchanged', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, '__goldens__', 'jest.json')
    const record = (text: string) => commitGolden(target, text, false)
    assert.deepEqual(await record('{"a":1}\n'), { outcome: 'written' })
    assert.equal(await readFile(target, 'utf8'), '{"a":1}\n')
    assert.deepEqual(await record('{"a":1}\n'), { outcome: 'unchanged' })
    assert.deepEqual(await record('{"a":2}\n'), { outcome: 'written' })
    assert.equal(await readFile(target, 'utf8'), '{"a":2}\n')
  })
})

test('commitGolden in check mode never writes: missing, matches or drift', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, '__goldens__', 'jest.json')
    const check = () => commitGolden(target, 'new\n', true)
    assert.deepEqual(await check(), { outcome: 'missing' })
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'old\n')
    const drift = await check()
    assert.equal(drift.outcome, 'drift')
    assert.match(drift.diff ?? '', /- old/)
    assert.match(drift.diff ?? '', /\+ new/)
    await writeFile(target, 'new\n')
    assert.deepEqual(await check(), { outcome: 'matches' })
  })
})
