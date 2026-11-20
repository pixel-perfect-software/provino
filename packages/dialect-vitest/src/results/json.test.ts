// T11.16: the Vitest JSON collector over a run's events, driven by hand. That the document is Vitest
// 5.0.5's, byte for byte, is held through `provino vitest` against the recorded `cli/vitest-json-*`.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { FileInfo, FileTask, SuiteTask, TaskId, TaskResult, TestTask } from '@provino/types'
import { createVitestResults, type VitestJsonResults } from './json.ts'

const id = (text: string): TaskId => text as TaskId

const info: FileInfo = { fileId: id('f'), path: 'src/a.test.ts', project: '', projectIndex: 0 }
const base = { fileId: id('f'), mode: 'run', location: null, tags: [], meta: {} } as const
const fileTask: FileTask = {
  ...base,
  id: id('f'),
  parentId: null,
  name: 'src/a.test.ts',
  type: 'file',
  path: 'src/a.test.ts',
  projectName: '',
  children: [id('s'), id('t3')],
}
const suite: SuiteTask = {
  ...base,
  id: id('s'),
  parentId: id('f'),
  name: 'math',
  type: 'suite',
  children: [id('t1'), id('t2')],
  each: false,
  concurrent: false,
  shuffle: false,
}
const test = (
  testId: TaskId,
  name: string,
  fullName: string[],
  extra: Partial<TestTask> = {},
): TestTask => ({
  ...base,
  id: testId,
  parentId: id('s'),
  name,
  type: 'test',
  fullName,
  dupIndex: 0,
  each: false,
  concurrent: false,
  expectFail: false,
  timeoutMs: 5000,
  retry: 0,
  repeats: 0,
  ...extra,
})
const t1 = test(id('t1'), 'adds', ['math', 'adds'], {
  location: { file: 'src/a.test.ts', line: 3, column: 5 },
})
const t2 = test(id('t2'), 'fails', ['math', 'fails'])
const t3 = test(id('t3'), 'later', ['later'], { mode: 'todo', parentId: id('f') })
const result = (state: TaskResult['state'], errors: TaskResult['errors'] = []): TaskResult => ({
  state,
  durationMs: 4,
  startTime: 0,
  errors,
  retryErrors: [],
  attempts: 1,
  repeatIndex: 0,
  assertions: 1,
  passingAssertions: 1,
})

function drive(includeTaskLocation: boolean) {
  let clock = 1000
  const results = createVitestResults({
    roots: ['/root'],
    passWithNoTests: false,
    includeTaskLocation,
    now: () => clock++,
  })
  const r = results.reporter as unknown as Record<string, (...args: unknown[]) => void>
  r['run:start']?.({}, [info])
  r['file:start']?.(info)
  r['file:collected']?.(info, { type: 'file-collect-end', tasks: [fileTask, suite, t1, t2, t3] })
  for (const [task, state] of [
    [t1, 'pass'],
    [t2, 'fail'],
    [t3, 'todo'],
  ] as const) {
    r['task:start']?.(task, { type: 'test-start' })
    const errors =
      state === 'fail'
        ? [
            {
              name: 'AssertionError',
              message: 'expected 1 to be 2',
              stack: 'AssertionError: expected 1 to be 2\n    at a',
            },
          ]
        : []
    r['task:end']?.(task, { type: 'test-end', result: result(state, errors) })
  }
  r['task:end']?.(suite, { type: 'suite-end', result: result('fail') })
  r['file:end']?.({ file: info, state: 'fail', durationMs: 9, errors: [] })
  r['run:end']?.({ reason: 'failed', files: [], unhandled: [], durationMs: 9 })
  return results.json()
}

describe('createVitestResults', () => {
  it('counts suites (files among them) and tests as JsonReporter does', () => {
    const json = drive(false)
    assert.deepEqual(
      [
        json.numTotalTestSuites,
        json.numPassedTestSuites,
        json.numFailedTestSuites,
        json.numPendingTestSuites,
      ],
      [2, 0, 2, 0],
    )
    assert.deepEqual(
      [
        json.numTotalTests,
        json.numPassedTests,
        json.numFailedTests,
        json.numPendingTests,
        json.numTodoTests,
      ],
      [3, 1, 1, 0, 1],
    )
    assert.equal(json.success, false)
    // The clock read at `run:start` (`onInit`), after the one the collector took as it was made.
    assert.equal(json.startTime, 1001)
    assert.deepEqual(Object.keys(json), [
      'numTotalTestSuites',
      'numPassedTestSuites',
      'numFailedTestSuites',
      'numPendingTestSuites',
      'numTotalTests',
      'numPassedTests',
      'numFailedTests',
      'numPendingTests',
      'numTodoTests',
      'snapshot',
      'startTime',
      'success',
      'testResults',
    ])
  })

  it('writes each test with its titles, status and failure, and a location only when asked', () => {
    const [file] = drive(false).testResults
    assert.equal(file?.name, '/root/src/a.test.ts')
    assert.equal(file?.status, 'failed')
    assert.deepEqual(
      file?.assertionResults.map((a) => [
        a.fullName,
        a.status,
        a.failureMessages.length,
        a.location,
      ]),
      [
        ['math adds', 'passed', 0, undefined],
        ['math fails', 'failed', 1, undefined],
        ['later', 'todo', 0, undefined],
      ],
    )
    assert.deepEqual(drive(true).testResults[0]?.assertionResults[0]?.location, {
      line: 3,
      column: 5,
    })
  })

  it('writes the snapshot summary and counts a file and a describe as cli/vitest-json-snapshot recorded', async () => {
    const goldenPath = path.join(
      import.meta.dirname,
      '../../../harness/fixtures/cli/vitest-json-snapshot/__goldens__/vitest.json',
    )
    const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as {
      observed: { json: Record<string, VitestJsonResults> }
    }
    const recorded = golden.observed.json['.harness-out/vitest.json']
    assert.ok(recorded)
    const c = recorded.snapshot
    const results = createVitestResults({
      roots: ['/root'],
      passWithNoTests: false,
      includeTaskLocation: false,
    })
    const r = results.reporter as unknown as Record<string, (...args: unknown[]) => void>
    r['run:end']?.({
      reason: 'failed',
      files: [],
      unhandled: [],
      durationMs: 9,
      snapshots: {
        counters: {
          added: c.added,
          matched: c.matched,
          unmatched: c.unmatched,
          updated: c.updated,
          unchecked: c.unchecked,
          total: c.total,
          filesAdded: c.filesAdded,
          filesRemoved: c.filesRemoved,
          filesUnmatched: c.filesUnmatched,
          filesUpdated: c.filesUpdated,
        },
        uncheckedKeysByFile: [],
        update: 'new',
        files: [],
      },
    })
    // An unmatched snapshot leaves `failure` false, and the keys keep Vitest's order.
    assert.equal(c.failure, false)
    assert.deepEqual(JSON.stringify(results.json().snapshot), JSON.stringify(c))
    // One file with one describe, both failed: the hand-driven run above has the same shape.
    assert.deepEqual(
      [
        recorded.numTotalTestSuites,
        recorded.numPassedTestSuites,
        recorded.numFailedTestSuites,
        recorded.numPendingTestSuites,
      ],
      [2, 0, 2, 0],
    )
  })

  it('succeeds with no file only under passWithNoTests', () => {
    for (const passWithNoTests of [false, true]) {
      const results = createVitestResults({
        roots: ['/root'],
        passWithNoTests,
        includeTaskLocation: false,
      })
      assert.equal(results.json().success, passWithNoTests)
    }
  })
})
