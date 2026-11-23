import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'provino'
import JestWatchLogReporter, {
  WATCH_LOG_ENV,
  type WatchLogResults,
  watchLogEntry,
} from './jest-watch-log.ts'

const ROOT = '/work/fixture'

function file(
  name: string,
  tests: readonly { fullName: string; status: string }[],
  extra: Partial<WatchLogResults['testResults'][number]> = {},
): WatchLogResults['testResults'][number] {
  return {
    testFilePath: path.join(ROOT, name),
    numFailingTests: tests.filter((one) => one.status === 'failed').length,
    skipped: false,
    testResults: tests,
    ...extra,
  }
}

function results(
  files: WatchLogResults['testResults'],
  extra: Partial<WatchLogResults> = {},
): WatchLogResults {
  return {
    testResults: files,
    snapshot: { added: 0, updated: 0, unmatched: 0 },
    wasInterrupted: false,
    ...extra,
  }
}

test('an entry lists each file by root-relative path, sorted, with its tests in order', () => {
  const entry = watchLogEntry(
    results([
      file('src/b.test.ts', [
        { fullName: 'b second', status: 'passed' },
        { fullName: 'b first', status: 'failed' },
      ]),
      file('a.test.ts', [{ fullName: 'a', status: 'passed' }]),
    ]),
    ROOT,
  )
  assert.deepEqual(entry, {
    files: [
      { path: 'a.test.ts', status: 'passed', tests: [{ fullName: 'a', status: 'passed' }] },
      {
        path: 'src/b.test.ts',
        status: 'failed',
        tests: [
          { fullName: 'b second', status: 'passed' },
          { fullName: 'b first', status: 'failed' },
        ],
      },
    ],
    snapshot: { added: 0, updated: 0, unmatched: 0 },
    wasInterrupted: false,
  })
})

test('a file is failed, skipped or passed, and the snapshot and interrupt state are kept', () => {
  const entry = watchLogEntry(
    results(
      [
        file('crash.test.ts', [], { testExecError: { message: 'boom' } }),
        file('fail.test.ts', [{ fullName: 'x', status: 'failed' }], {
          testExecError: { message: 'also' },
        }),
        file('skip.test.ts', [{ fullName: 'y', status: 'pending' }], { skipped: true }),
        file('pass.test.ts', [{ fullName: 'z', status: 'passed' }], { testExecError: null }),
      ],
      { snapshot: { added: 1, updated: 2, unmatched: 3 }, wasInterrupted: true },
    ),
    ROOT,
  )
  assert.deepEqual(
    entry.files.map((one) => [one.path, one.status]),
    [
      ['crash.test.ts', 'failed'],
      ['fail.test.ts', 'failed'],
      ['pass.test.ts', 'passed'],
      ['skip.test.ts', 'skipped'],
    ],
  )
  assert.deepEqual(entry.snapshot, { added: 1, updated: 2, unmatched: 3 })
  assert.equal(entry.wasInterrupted, true)
  // Only the counters a watch key changes, whatever else Jest's summary holds.
  const wide = { ...results([]), snapshot: { added: 0, updated: 0, unmatched: 0, matched: 9 } }
  assert.deepEqual(Object.keys(watchLogEntry(wide, ROOT).snapshot), [
    'added',
    'updated',
    'unmatched',
  ])
})

test('the reporter appends one line per run and never empties the file (Jest makes it again each run)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-log-'))
  try {
    const log = path.join(dir, 'runs.jsonl')
    await writeFile(log, '')
    const first = new JestWatchLogReporter({ rootDir: ROOT }, { outputFile: log })
    first.onRunComplete(new Set(), results([file('a.test.ts', [])]))
    const second = new JestWatchLogReporter({ rootDir: ROOT }, { outputFile: log })
    second.onRunComplete(new Set(), results([], { wasInterrupted: true }))
    const lines = (await readFile(log, 'utf8')).split('\n')
    assert.equal(lines.length, 3)
    assert.equal(lines[2], '')
    assert.equal(JSON.parse(lines[0] ?? '').files[0].path, 'a.test.ts')
    assert.equal(JSON.parse(lines[1] ?? '').wasInterrupted, true)
    assert.equal(first.getLastError(), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the file comes from the options, else the environment, and a reporter with neither throws', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-log-'))
  const saved = process.env[WATCH_LOG_ENV]
  try {
    const log = path.join(dir, 'env.jsonl')
    process.env[WATCH_LOG_ENV] = log
    new JestWatchLogReporter({ rootDir: ROOT }).onRunComplete(undefined, results([]))
    assert.equal((await readFile(log, 'utf8')).split('\n').length, 2)
    delete process.env[WATCH_LOG_ENV]
    assert.throws(() => new JestWatchLogReporter({ rootDir: ROOT }), /needs a file to write/)
    assert.throws(
      () => new JestWatchLogReporter({ rootDir: ROOT }, { outputFile: '' }),
      /needs a file/,
    )
  } finally {
    if (saved === undefined) delete process.env[WATCH_LOG_ENV]
    else process.env[WATCH_LOG_ENV] = saved
    await rm(dir, { recursive: true, force: true })
  }
})

test("a file's status is Jest's own: skipped first, then failed for a failing test or an exec error", () => {
  // `@jest/test-result` addResult and `getResultHeader`: a skipped file counts as skipped even
  // with an error, an exec error with no failing test is a failure, and `failureMessage` decides
  // nothing.
  // A result as Jest gives it carries more fields than the log reads.
  const messageOnly = {
    ...file('message-only.test.ts', [{ fullName: 'a', status: 'passed' }]),
    failureMessage: 'printed, but no test failed',
  }
  const entry = watchLogEntry(
    results([
      file('skipped-error.test.ts', [], { skipped: true, testExecError: { message: 'x' } }),
      file('exec-error.test.ts', [], { testExecError: { message: 'boom' } }),
      messageOnly,
    ]),
    ROOT,
  )
  assert.deepEqual(
    entry.files.map((one) => [one.path, one.status, one.execError === true]),
    [
      ['exec-error.test.ts', 'failed', true],
      ['message-only.test.ts', 'passed', false],
      ['skipped-error.test.ts', 'skipped', true],
    ],
  )
})
