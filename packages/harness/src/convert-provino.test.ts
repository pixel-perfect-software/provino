import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NormalizedRun } from '@provino/types'
import { convertProvino } from './convert-provino.ts'
import { HarnessError } from './errors.ts'
import { makeRun } from './test-support.ts'

const ROOT = '/work/sample'

// What Provino's normalized-json reporter writes for a failure: the message with ANSI stripped
// but paths kept, no user frame, and the stack as `raw`.
const STACK = [
  'Error: expect(received).toBe(expected) // Object.is equality',
  '',
  'Expected: 4',
  'Received: 3',
  `    at Object.<anonymous> (${ROOT}/fail.test.ts:3:19)`,
  '    at run (/repo/node_modules/provino/src/run.ts:10:5)',
].join('\n')

function provinoRun(overrides: Partial<NormalizedRun> = {}): NormalizedRun {
  return makeRun(
    [
      {
        file: 'fail.test.ts',
        status: 'failed',
        tests: [
          {
            id: { file: 'fail.test.ts', path: ['toBe'], dupIndex: 0 },
            status: 'failed',
            errors: [
              {
                name: 'Error',
                message: `expect(received).toBe(expected) at ${ROOT}/fail.test.ts`,
                matcher: 'toBe',
                raw: STACK,
              },
            ],
            console: [{ stream: 'stdout', text: `wrote ${ROOT}/out.txt (12 ms)`, level: 'log' }],
          },
        ],
        console: [{ stream: 'stderr', text: 'top level' }],
      },
      {
        file: `${ROOT}/crash.test.ts`,
        status: 'crashed',
        fileError: {
          message: 'gone',
          raw: `Error: Cannot find module './x' from ${ROOT}/crash.test.ts`,
        },
        tests: [],
      },
    ],
    { runner: 'provino:jest', runnerVersion: '0.0.0', suite: 'sample', ...overrides },
  )
}

function text(run: NormalizedRun): string {
  return JSON.stringify(run)
}

test('errors are normalized again from raw: <root>, the first user frame, the matcher kept', () => {
  const run = convertProvino(text(provinoRun()), { rootDir: ROOT })
  const [failed, crashed] = run.files.toSorted((a, b) => (a.file < b.file ? 1 : -1))
  assert.deepEqual(failed?.tests[0]?.errors, [
    {
      name: 'Error',
      message:
        'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 4\nReceived: 3',
      matcher: 'toBe',
      userFrame: '<root>/fail.test.ts:3:19',
      raw: STACK,
    },
  ])
  assert.deepEqual(crashed?.fileError, {
    name: 'Error',
    message: "Error: Cannot find module './x' from <root>/crash.test.ts",
    raw: `Error: Cannot find module './x' from ${ROOT}/crash.test.ts`,
  })
})

test('an absolute file path is made relative to the root, and files are sorted', () => {
  const run = convertProvino(text(provinoRun()), { rootDir: ROOT })
  assert.deepEqual(
    run.files.map((file) => file.file),
    ['crash.test.ts', 'fail.test.ts'],
  )
})

test('console lines are normalized, and the rules that fired are collected', () => {
  const fired = new Set<string>()
  const run = convertProvino(text(provinoRun()), { rootDir: ROOT, fired })
  const file = run.files.find((f) => f.file === 'fail.test.ts')
  assert.deepEqual(file?.tests[0]?.console, [
    { stream: 'stdout', text: 'wrote <root>/out.txt (<dur>)', level: 'log' },
  ])
  assert.deepEqual(file?.console, [{ stream: 'stderr', text: 'top level' }])
  for (const rule of ['root', 'durations', 'stack']) assert.ok(fired.has(rule), rule)
})

test('suite and snapshot files replace what the file has; without them they are kept', () => {
  const kept = convertProvino(text(provinoRun()), { rootDir: ROOT })
  assert.equal(kept.suite, 'sample')
  assert.equal(kept.snapshots, undefined)
  const replaced = convertProvino(text(provinoRun()), {
    rootDir: ROOT,
    suite: 'harness/sample',
    snapshotFiles: [
      { file: 'b.snap', sha256: 'b'.repeat(64) },
      { file: 'a.snap', sha256: 'a'.repeat(64) },
    ],
  })
  assert.equal(replaced.suite, 'harness/sample')
  assert.deepEqual(
    replaced.snapshots?.files.map((file) => file.file),
    ['a.snap', 'b.snap'],
  )
  assert.equal(replaced.snapshots?.counters.total, 0)
  assert.equal(replaced.runner, 'provino:jest')
})

test('a file that is not a NormalizedRun is HARNESS_RESULT_INVALID, naming its first wrong path', () => {
  const broken = JSON.parse(text(provinoRun())) as { files: { tests: { status: unknown }[] }[] }
  const first = broken.files[0]?.tests[0]
  assert.ok(first)
  first.status = 'exploded'
  assert.throws(
    () => convertProvino(JSON.stringify(broken), { rootDir: ROOT }, 'provino.json'),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_RESULT_INVALID' &&
      error.message.includes('files[0].tests[0].status') &&
      error.message.includes('provino.json'),
  )
  assert.throws(
    () => convertProvino('{', { rootDir: ROOT }),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_RESULT_INVALID',
  )
})
