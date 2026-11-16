// The pure builders over synthetic events: status mapping, `.each` rows, retries, a file that could
// not run, an all-skipped file and a focused one. The recordings of what Jest does are
// `provino`'s `jest-json.test.ts` (`cli/json-*`).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  FileResult,
  FileTask,
  SerializedError,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
} from '@provino/types'
import {
  type BuildOptions,
  type FileEvents,
  finishAggregated,
  flattenSerializedError,
  LEAK_MESSAGE,
  NO_TESTS_MESSAGE,
  type TestRecord,
  toAssertionResult,
  toTestResult,
} from './build.ts'
import { addResult, makeEmptyAggregatedTestResult } from './helpers.ts'

const id = (name: string): TaskId => name as TaskId
const OPTIONS: BuildOptions = { locations: true, displayName: undefined }

function test(
  name: string,
  parent: string,
  patch: Partial<TestTask> = {},
  titles: readonly string[] = ['suite', name],
): TestTask {
  return {
    type: 'test',
    id: id(name),
    parentId: id(parent),
    fileId: id('file'),
    name,
    mode: 'run',
    location: { file: '/a.test.ts', line: 4, column: 3 },
    tags: [],
    meta: {},
    fullName: titles,
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail: false,
    timeoutMs: 5000,
    retry: 0,
    repeats: 0,
    ...patch,
  }
}

function result(state: TaskResult['state'], patch: Partial<TaskResult> = {}): TaskResult {
  return {
    state,
    durationMs: 4.6,
    startTime: 1,
    errors: [],
    retryErrors: [],
    attempts: state === 'skip' || state === 'todo' ? 0 : 1,
    repeatIndex: 0,
    assertions: 0,
    passingAssertions: 0,
    ...patch,
  }
}

const failure = (message: string, details?: SerializedError['details']): SerializedError => ({
  name: 'Error',
  message,
  stack: `Error: ${message}\n    at x (/a.test.ts:4:3)`,
  ...(details === undefined ? {} : { details }),
})

function events(
  tests: readonly { task: TestTask; result?: TaskResult }[],
  patch: Partial<FileEvents> = {},
  fileResult: Partial<FileResult> = {},
): FileEvents {
  const file: FileTask = {
    type: 'file',
    id: id('file'),
    parentId: null,
    fileId: id('file'),
    name: 'a.test.ts',
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
    path: 'a.test.ts',
    projectName: 'p',
    children: tests.map((entry) => entry.task.id),
  }
  const tree: TaskNode[] = [file, ...tests.map((entry) => entry.task)]
  const records = new Map<TaskId, TestRecord>(
    tests.map((entry) => [
      entry.task.id,
      {
        task: entry.task,
        result: entry.result,
        startedAt: 100,
      },
    ]),
  )
  return {
    info: { fileId: id('file'), path: 'a.test.ts', project: 'p' },
    testFilePath: '/a.test.ts',
    tree,
    records,
    result: {
      file: { fileId: id('file'), path: 'a.test.ts', project: 'p' },
      state: 'pass',
      durationMs: 9,
      errors: [],
      ...fileResult,
    },
    unhandled: [],
    startedAt: 1000,
    endedAt: 1250,
    ...patch,
  }
}

describe('toAssertionResult', () => {
  it('maps the states to Jest statuses, and a skipped or todo test has no duration', () => {
    const cases: [TaskResult['state'], string, number | null][] = [
      ['pass', 'passed', 5],
      ['fail', 'failed', 5],
      ['skip', 'pending', null],
      ['todo', 'todo', null],
    ]
    for (const [state, status, duration] of cases) {
      const built = toAssertionResult(
        { task: test('t', 'file'), result: result(state), startedAt: 7 },
        OPTIONS,
      )
      assert.equal(built.status, status, state)
      assert.equal(built.duration, duration, state)
      assert.equal(built.startAt, 7)
      // Jest reports 1 invocation even for a test it did not run.
      assert.equal(built.invocations, 1)
    }
  })

  it('splits the full name, joins it with a space and gives the location (or none)', () => {
    const task = test('t', 'file', {}, ['outer', 'inner', 'works'])
    const record = { task, result: result('pass'), startedAt: null }
    const built = toAssertionResult(record, OPTIONS)
    assert.deepEqual(built.ancestorTitles, ['outer', 'inner'])
    assert.equal(built.title, 'works')
    assert.equal(built.fullName, 'outer inner works')
    assert.deepEqual(built.location, { column: 3, line: 4 })
    assert.equal(toAssertionResult(record, { ...OPTIONS, locations: false }).location, null)
  })

  it('gives each row of an each table the location the call has', () => {
    const rows = [
      test('r1', 'file', { each: true }, ['suite', 'row 1']),
      test('r2', 'file', { each: true }, ['suite', 'row 2']),
    ]
    const built = rows.map((task) =>
      toAssertionResult({ task, result: result('pass'), startedAt: 1 }, OPTIONS),
    )
    assert.deepEqual(
      built.map((entry) => entry.location),
      [
        { column: 3, line: 4 },
        { column: 3, line: 4 },
      ],
    )
  })

  it('carries failures as flattened stacks and details, and retries as retryReasons', () => {
    const matcher = { matcherResult: { actual: 1, expected: 2, name: 'toBe', pass: false } }
    const built = toAssertionResult(
      {
        task: test('t', 'file'),
        result: result('fail', {
          errors: [failure('boom', matcher)],
          passingAssertions: 2,
          attempts: 3,
          retryErrors: [failure('first'), failure('second')],
        }),
        startedAt: 1,
      },
      OPTIONS,
    )
    assert.deepEqual(built.failureMessages, ['Error: boom\n    at x (/a.test.ts:4:3)'])
    assert.deepEqual(built.failureDetails, [matcher])
    assert.deepEqual(built.retryReasons, [
      'Error: first\n    at x (/a.test.ts:4:3)',
      'Error: second\n    at x (/a.test.ts:4:3)',
    ])
    assert.equal(built.invocations, 3)
    assert.equal(built.numPassingAsserts, 2)
  })

  it('has `{}` for the details of an error that carries none, as Jest has for a plain Error', () => {
    const built = toAssertionResult(
      {
        task: test('t', 'file'),
        result: result('fail', { errors: [failure('plain')] }),
        startedAt: 1,
      },
      OPTIONS,
    )
    assert.deepEqual(built.failureDetails, [{}])
  })

  it('keeps a name the thrown error set as its own enumerable property (ecosystem/rtl-cleanup)', () => {
    // dom-testing-library's `TestingLibraryElementError` does `this.name = …` in its constructor,
    // so Jest's JSON of it is `{ name }`; the message and stack stay hidden, as an Error's are.
    const thrown: SerializedError = {
      ...failure('not found', { name: 'TestingLibraryElementError' }),
      name: 'TestingLibraryElementError',
      enumerableFields: ['name'],
    }
    const built = toAssertionResult(
      {
        task: test('t', 'file'),
        result: result('fail', { errors: [thrown] }),
        startedAt: 1,
      },
      OPTIONS,
    )
    assert.equal(JSON.stringify(built.failureDetails), '[{"name":"TestingLibraryElementError"}]')
    const [detail] = built.failureDetails as [{ message: string }]
    assert.equal(detail.message, 'not found')
  })

  it('keeps a name hidden that only the thrown value’s JSON had, not the value itself', () => {
    // `details` holds `name` because the value's `toJSON` wrote it; the error's own is not enumerable.
    const thrown: SerializedError = failure('m', { name: 'FromJson', code: 1 })
    const built = toAssertionResult(
      {
        task: test('t', 'file'),
        result: result('fail', { errors: [thrown] }),
        startedAt: 1,
      },
      OPTIONS,
    )
    assert.equal(JSON.stringify(built.failureDetails), '[{"code":1}]')
  })

  describe('failureDetails of an error whose details enumerate a message', () => {
    const provinoFrame = '    at run (/app/node_modules/provino/dist/worker/jest-runtime.js:1:100)'
    const details = (error: SerializedError): Record<string, unknown> => {
      const built = toAssertionResult(
        {
          task: test('t', 'file'),
          result: result('fail', { errors: [error] }),
          startedAt: 1,
        },
        OPTIONS,
      )
      return built.failureDetails[0] as Record<string, unknown>
    }

    it('keeps a shaped node:assert error`s message enumerable, its name hidden, and hides our frames', () => {
      const message = `assert.equal(received, expected)\n    at t (/a.test.ts:1:1)\n${provinoFrame}`
      const shaped = details({
        name: 'AssertionError',
        code: 'ERR_ASSERTION',
        message,
        stack: message,
        details: { message },
      })
      assert.deepEqual(Object.keys(shaped), ['message'])
      assert.equal(shaped.message, 'assert.equal(received, expected)\n    at t (/a.test.ts:1:1)')
      assert.equal(shaped.name, 'AssertionError')
    })

    it('leaves every other error as it was: the message hidden, our frames dropped', () => {
      const message = `thrown\n${provinoFrame}`
      const other = details({ name: 'Error', message, details: { message } })
      assert.deepEqual(Object.keys(other), [])
      assert.equal(other.message, 'thrown')
    })

    it('keeps the thrown value’s own message as thrown, not the serializer’s text (cli/json-thrown-values)', () => {
      // `throw { message: 'boom' }`: the value is not error-like, so the serializer's message is
      // its description; Jest's JSON is the value's own keys.
      const thrown = details({
        name: 'Error',
        message: '[object Object]',
        details: { message: 'boom' },
        enumerableFields: ['message'],
      })
      assert.equal(JSON.stringify(thrown), '{"message":"boom"}')
    })

    it('keeps a non-string own message as thrown', () => {
      const thrown = details({
        name: 'Error',
        message: '42',
        details: { message: 42, code: 'E' },
        enumerableFields: ['message'],
      })
      assert.equal(JSON.stringify(thrown), '{"message":42,"code":"E"}')
    })

    it('hides our frames in an own enumerable stack', () => {
      const stack = `Error: own\n    at t (/a.test.ts:1:1)\n${provinoFrame}`
      const thrown = details({
        name: 'Error',
        message: 'own',
        stack,
        details: { stack },
        enumerableFields: ['stack'],
      })
      assert.equal(
        JSON.stringify(thrown),
        JSON.stringify({ stack: 'Error: own\n    at t (/a.test.ts:1:1)' }),
      )
    })
  })
})

describe('flattenSerializedError', () => {
  it('prepends a message the stack lacks, and appends causes and aggregate errors', () => {
    const error: SerializedError = {
      name: 'Error',
      message: 'top',
      stack: 'Error:\n    at somewhere',
      cause: { name: 'Error', message: 'root', stack: 'Error: root\n    at y' },
      errors: [{ name: 'Error', message: 'one' }],
    }
    assert.equal(
      flattenSerializedError(error),
      'top\n    at somewhere\n\n[cause]: Error: root\n    at y\n\n[errors]: one',
    )
  })
})

describe('toTestResult', () => {
  it('counts by status and reports a plain file', () => {
    const built = toTestResult(
      events(
        [
          { task: test('a', 'file'), result: result('pass') },
          { task: test('b', 'file'), result: result('fail', { errors: [failure('x')] }) },
          { task: test('c', 'file'), result: result('skip') },
          { task: test('d', 'file'), result: result('todo') },
        ],
        {},
        { state: 'fail' },
      ),
      OPTIONS,
    )
    assert.deepEqual(
      [built.numPassingTests, built.numFailingTests, built.numPendingTests, built.numTodoTests],
      [1, 1, 1, 1],
    )
    assert.equal(built.skipped, false)
    assert.equal(built.testExecError, undefined)
    assert.deepEqual(
      built.testResults.map((entry) => entry.title),
      ['a', 'b', 'c', 'd'],
      'declaration order',
    )
    assert.equal(built.perfStats.start, 1000)
    assert.equal(built.perfStats.end, 1250)
    assert.equal(built.perfStats.runtime, 250)
    assert.equal(built.testFilePath, '/a.test.ts')
  })

  it('is skipped when every test is pending, and not when a todo is among them', () => {
    const skipped = toTestResult(
      events(
        [
          { task: test('a', 'file'), result: result('skip') },
          { task: test('b', 'file'), result: result('skip') },
        ],
        {},
        { state: 'skip' },
      ),
      OPTIONS,
    )
    assert.equal(skipped.skipped, true)
    const todo = toTestResult(
      events([
        { task: test('a', 'file'), result: result('skip') },
        { task: test('b', 'file'), result: result('todo') },
      ]),
      OPTIONS,
    )
    assert.equal(todo.skipped, false)
  })

  it('a file that never collected is a runtime error with no tests', () => {
    const built = toTestResult(
      events([], { tree: undefined }, { state: 'fail', errors: [failure('cannot load')] }),
      OPTIONS,
    )
    assert.equal(built.testExecError?.message, 'cannot load')
    assert.deepEqual(built.testResults, [])
    assert.equal(built.skipped, false)
  })

  it('a worker that died with a test unfinished is a runtime error, not a test result', () => {
    const built = toTestResult(
      events(
        [{ task: test('a', 'file') }],
        {},
        { state: 'fail', errors: [{ name: 'WorkerCrash', message: 'exited' }] },
      ),
      OPTIONS,
    )
    assert.equal(built.testExecError?.message, 'exited')
    assert.deepEqual(built.testResults, [])
  })

  it('a crashed file is Jest’s buildFailureTestResult: no counts, no tests, even for tests that ended', () => {
    const built = toTestResult(
      events(
        [
          { task: test('a', 'file'), result: result('pass') },
          { task: test('b', 'file'), result: result('fail', { errors: [failure('x')] }) },
          { task: test('c', 'file') },
        ],
        {},
        {
          state: 'fail',
          workerExit: { type: 'exit', code: 1 },
          errors: [{ name: 'WorkerCrash', message: 'the worker exited' }],
        },
      ),
      OPTIONS,
    )
    assert.deepEqual(
      [built.numPassingTests, built.numFailingTests, built.numPendingTests, built.numTodoTests],
      [0, 0, 0, 0],
    )
    assert.deepEqual(built.testResults, [])
    assert.equal(built.testExecError?.message, 'the worker exited')
    assert.equal(built.testFilePath, '/a.test.ts')
    assert.equal(built.skipped, false)
    const run = makeEmptyAggregatedTestResult()
    addResult(run, built)
    assert.deepEqual(
      [run.numFailedTests, run.numTotalTests, run.numRuntimeErrorTestSuites],
      [0, 0, 1],
    )
  })

  it('a file that leaks (--detectLeaks) is a runtime error with Jest’s text, and counts no test', () => {
    const built = toTestResult(
      events(
        [{ task: test('a', 'file'), result: result('pass') }],
        {},
        { state: 'fail', leaks: true, resultsDiscarded: true, errors: [] },
      ),
      OPTIONS,
    )
    assert.equal(built.testExecError?.message, LEAK_MESSAGE)
    assert.match(LEAK_MESSAGE, /^EXPERIMENTAL FEATURE!\nYour test suite is leaking memory\./)
    assert.deepEqual(built.testResults, [])
    assert.equal(built.numPassingTests, 0)
  })

  it('a file with no test that also leaks reads "must contain": onResult checks the length before leaks', () => {
    // TestScheduler.ts L144 (`testResults.length === 0`) comes before L153 (`testResult.leaks`).
    const built = toTestResult(
      events([], {}, { state: 'fail', leaks: true, resultsDiscarded: true, errors: [] }),
      OPTIONS,
    )
    assert.equal(built.testExecError?.message, NO_TESTS_MESSAGE)
    assert.notEqual(built.testExecError?.message, LEAK_MESSAGE)
  })

  it('a file’s heap (--logHeapUsage) is the result’s memoryUsage', () => {
    const built = toTestResult(
      events([{ task: test('a', 'file'), result: result('pass') }], {}, { heapUsedBytes: 123_456 }),
      OPTIONS,
    )
    assert.equal(built.memoryUsage, 123_456)
    const none = toTestResult(
      events([{ task: test('a', 'file'), result: result('pass') }], {}),
      OPTIONS,
    )
    assert.equal('memoryUsage' in none, false)
  })

  it('a file with no test fails with Jest’s message', () => {
    const built = toTestResult(events([], {}, { state: 'fail' }), OPTIONS)
    assert.equal(built.testExecError?.message, NO_TESTS_MESSAGE)
  })

  it('a file that loaded and has no test result has Jest’s message whatever errors it holds: onResult tests only the length', () => {
    // `cli/empty-test-file-error-timing` (circus's own error) and `cli/empty-test-file-timer-throws`.
    const circus = events(
      [],
      {},
      {
        state: 'fail',
        errors: [
          failure('Invalid: beforeEach() may not be used in a describe block containing no tests.'),
        ],
      },
    )
    const timer = events([], { unhandled: [failure('thrown from a timer')] }, { state: 'fail' })
    // The error the orchestrator gives a file it failed for declaring no test (`ORCH_NO_TESTS`):
    // Provino's own text, which Jest's replaces.
    const orchestrator = events(
      [],
      {},
      {
        state: 'fail',
        errors: [{ name: 'Error', message: 'The file declares no tests', code: 'ORCH_NO_TESTS' }],
      },
    )
    for (const file of [circus, timer, orchestrator]) {
      const built = toTestResult(file, OPTIONS)
      assert.equal(built.testExecError?.message, NO_TESTS_MESSAGE)
      assert.deepEqual(built.testResults, [])
      assert.equal(built.numFailingTests, 0)
    }
  })

  it('a file the worker’s runner failed after it ran keeps that error: runTest rejects, so onResult’s check never ran', () => {
    // A custom environment's `teardown()` that throws, a mock or clock dispose, `sendCoverage`.
    const teardown = failure('teardown failed')
    const built = toTestResult(
      events([], { runnerFailed: true, unhandled: [teardown] }, { state: 'fail' }),
      OPTIONS,
    )
    assert.equal(built.testExecError?.message, 'teardown failed')
    assert.deepEqual(built.testResults, [])
    // Without the mark the same error is a timer's or a hook's, which Jest drops.
    const unmarked = toTestResult(events([], { unhandled: [teardown] }, { state: 'fail' }), OPTIONS)
    assert.equal(unmarked.testExecError?.message, NO_TESTS_MESSAGE)
  })

  it('a file that never loaded keeps its own error, with a tree or without one', () => {
    // `cli/empty-test-file-error-timing`: a throw while the file loads is `onFailure`'s.
    const errors = [failure('thrown while loading')]
    for (const patch of [{ loadFailed: true as const }, { tree: undefined }]) {
      const built = toTestResult(events([], patch, { state: 'fail', errors }), OPTIONS)
      assert.equal(built.testExecError?.message, 'thrown while loading')
    }
  })

  it('errors beside tests that ran are the file’s exec error, joined as Jest joins them', () => {
    const built = toTestResult(
      events([{ task: test('a', 'file'), result: result('pass') }], {
        unhandled: [failure('late')],
      }),
      OPTIONS,
    )
    assert.equal(built.testExecError?.message, '')
    assert.equal(built.testExecError?.stack, 'Error: late\n    at x (/a.test.ts:4:3)')
    assert.equal(built.numPassingTests, 1)
  })

  it('takes the snapshot counts of the file', () => {
    const snapshot = {
      file: null,
      added: 1,
      matched: 2,
      unmatched: 3,
      updated: 4,
      unchecked: 5,
      uncheckedKeys: ['k'],
      fileDeleted: true,
    }
    const built = toTestResult(
      events([{ task: test('a', 'file'), result: result('pass') }], {}, { snapshot }),
      OPTIONS,
    )
    assert.deepEqual(built.snapshot, {
      added: 1,
      fileDeleted: true,
      matched: 2,
      unchecked: 5,
      uncheckedKeys: ['k'],
      unmatched: 3,
      updated: 4,
    })
  })
})

describe('a collect-only file (--collectTests)', () => {
  const collect: BuildOptions = { ...OPTIONS, collectOnly: true }

  it('reports a queued test as passed with wouldRun, and nothing a run would know', () => {
    const built = toTestResult(
      events([
        { task: test('a', 'file'), result: result('queued', { attempts: 0 }) },
        { task: test('b', 'file'), result: result('skip') },
        { task: test('c', 'file'), result: result('todo') },
      ]),
      collect,
    )
    assert.deepEqual(
      built.testResults.map((entry) => [entry.status, entry.wouldRun]),
      [
        ['passed', true],
        ['pending', undefined],
        ['todo', undefined],
      ],
    )
    for (const entry of built.testResults) {
      assert.deepEqual(
        [entry.duration, entry.invocations, entry.location, entry.startAt, entry.numPassingAsserts],
        [null, 0, null, null, 0],
      )
      assert.equal('retryMessages' in entry, false)
    }
    assert.deepEqual(
      [built.numPassingTests, built.numPendingTests, built.numTodoTests, built.skipped],
      [1, 1, 1, false],
    )
  })

  it('fails a file with no test, as TestScheduler.onResult does, whatever state it ended in', () => {
    const built = toTestResult(events([]), collect)
    assert.equal(built.testExecError?.message, NO_TESTS_MESSAGE)
    assert.deepEqual(built.testResults, [])
  })

  it('ignores the errors circus files under unhandledErrors when tests were collected', () => {
    const built = toTestResult(
      events(
        [{ task: test('a', 'file'), result: result('queued', { attempts: 0 }) }],
        {},
        { state: 'fail', errors: [failure('Invalid: beforeEach() may not be used')] },
      ),
      collect,
    )
    assert.equal(built.testExecError, undefined)
    assert.equal(built.numPassingTests, 1)
    // ...and a file whose describe holds only hooks collected no test: "must contain a test".
    const hooksOnly = events([], {}, { state: 'fail', errors: [failure('Invalid: beforeEach()')] })
    const suite = { ...test('s', 'file'), type: 'suite', children: [] } as unknown as TaskNode
    const empty = toTestResult({ ...hooksOnly, tree: [...(hooksOnly.tree ?? []), suite] }, collect)
    assert.equal(empty.testExecError?.message, NO_TESTS_MESSAGE)
  })

  it('sets skipped, displayName and perfStats on the collected result, as runTest.ts does', () => {
    const pending = toTestResult(
      events([{ task: test('a', 'file'), result: result('skip') }], {
        startedAt: 100,
        endedAt: 130,
      }),
      { ...collect, displayName: { name: 'p', color: 'white' } },
    )
    assert.equal(pending.skipped, true)
    assert.deepEqual(pending.displayName, { name: 'p', color: 'white' })
    assert.deepEqual(
      [pending.perfStats.start, pending.perfStats.end, pending.perfStats.runtime],
      [100, 130, 30],
    )
    assert.equal(pending.perfStats.slow, false)
  })

  it('keeps a file that could not load as a runtime error', () => {
    const built = toTestResult(
      events([], { tree: undefined }, { state: 'fail', errors: [failure('cannot load')] }),
      collect,
    )
    assert.equal(built.testExecError?.message, 'cannot load')
  })
})

describe('finishAggregated', () => {
  const end = (reason: 'passed' | 'interrupted', update?: 'all' | 'none') => ({
    reason,
    reporterFailed: false,
    snapshots:
      update === undefined
        ? undefined
        : { counters: {} as never, uncheckedKeysByFile: [], update, files: [] },
  })

  it('fails the run on a failed test, an obsolete snapshot (unless -u) or an interruption', () => {
    const clean = makeEmptyAggregatedTestResult()
    finishAggregated(clean, end('passed'))
    assert.equal(clean.success, true)

    const failed = makeEmptyAggregatedTestResult()
    failed.numFailedTests = 1
    finishAggregated(failed, end('passed'))
    assert.equal(failed.success, false)

    const obsolete = makeEmptyAggregatedTestResult()
    obsolete.snapshot.unchecked = 1
    finishAggregated(obsolete, end('passed', 'none'))
    assert.deepEqual(
      [obsolete.snapshot.failure, obsolete.success, obsolete.snapshot.didUpdate],
      [true, false, false],
    )

    const updated = makeEmptyAggregatedTestResult()
    updated.snapshot.unchecked = 1
    finishAggregated(updated, end('passed', 'all'))
    assert.deepEqual(
      [updated.snapshot.failure, updated.success, updated.snapshot.didUpdate],
      [false, true, true],
    )

    const cut = makeEmptyAggregatedTestResult()
    finishAggregated(cut, end('interrupted'))
    assert.equal(cut.wasInterrupted, true)
  })
})
