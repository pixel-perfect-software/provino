// The collector over a played run: the events a coordinator emits, in its order, folded into the
// aggregate. `jest-message-util` formats the failure text (it is the real package).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  FileInfo,
  FileResult,
  FileTask,
  RunSummary,
  SerializedError,
  TaskId,
  TaskResult,
  TestTask,
} from '@provino/types'
import { createJestResults, type ProjectConfigLike } from './collect.ts'

const id = (name: string): TaskId => name as TaskId

const config: ProjectConfigLike = {
  rootDir: '/proj',
  testMatch: ['**/*.test.ts'],
  testLocationInResults: true,
  displayName: { name: 'unit', color: 'white' },
}

function infoOf(path: string, projectIndex?: number): FileInfo {
  return {
    fileId: id(path),
    path,
    project: 'p',
    ...(projectIndex === undefined ? {} : { projectIndex }),
  }
}

function testOf(file: string, name: string): TestTask {
  return {
    type: 'test',
    id: id(`${file}:${name}`),
    parentId: id(file),
    fileId: id(file),
    name,
    mode: 'run',
    location: { file: `/proj/${file}`, line: 2, column: 3 },
    tags: [],
    meta: {},
    fullName: ['suite', name],
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail: false,
    timeoutMs: 5000,
    retry: 0,
    repeats: 0,
  }
}

function resultOf(state: 'pass' | 'fail' | 'skip', errors: SerializedError[] = []): TaskResult {
  return {
    state,
    durationMs: 3,
    startTime: 0,
    errors,
    retryErrors: [],
    attempts: state === 'skip' ? 0 : 1,
    repeatIndex: 0,
    assertions: 1,
    passingAssertions: state === 'pass' ? 1 : 0,
  }
}

const SUMMARY: RunSummary = { reason: 'failed', files: [], unhandled: [], durationMs: 5 }

describe('createJestResults', () => {
  it('folds a played run into an AggregatedResult, in the order the files ended', async () => {
    let clock = 1000
    const results = createJestResults({
      globalConfig: { noStackTrace: false },
      projectConfigs: [config],
      now: () => (clock += 10),
    })
    const { reporter } = results
    const a = infoOf('a.test.ts')
    const b = infoOf('b.test.ts')
    const tasks = (file: FileInfo, names: string[]): FileTask[] => {
      const children = names.map((name) => testOf(file.path, name))
      const root: FileTask = {
        type: 'file',
        id: file.fileId,
        parentId: null,
        fileId: file.fileId,
        name: file.path,
        mode: 'run',
        location: null,
        tags: [],
        meta: {},
        path: file.path,
        projectName: 'p',
        children: children.map((child) => child.id),
      }
      return [root, ...children] as unknown as FileTask[]
    }
    await reporter['run:start']?.({ root: '/proj', projects: ['p'], startTime: 0, watch: false }, [
      a,
      b,
    ])
    // b ends first.
    for (const [file, names, outcome] of [
      [b, ['skips'], 'skip'],
      [a, ['works', 'breaks'], 'mixed'],
    ] as const) {
      await reporter['file:start']?.(file, 1)
      const tree = tasks(file, [...names])
      await reporter['file:collected']?.(file, {
        type: 'file-collect-end',
        fileId: file.fileId,
        tasks: tree,
        errors: [],
        t: 0,
      })
      for (const task of tree.slice(1) as unknown as TestTask[]) {
        await reporter['task:start']?.(task, { type: 'test-start', id: task.id, t: 0 })
        const failed = task.name === 'breaks'
        const state = outcome === 'skip' ? 'skip' : failed ? 'fail' : 'pass'
        await reporter['task:end']?.(task, {
          type: 'test-end',
          id: task.id,
          result: resultOf(
            state,
            failed
              ? [
                  {
                    name: 'Error',
                    message: 'nope',
                    stack: 'Error: nope\n    at t (/proj/a.test.ts:2:3)',
                  },
                ]
              : [],
          ),
          t: 0,
        })
      }
      const fileResult: FileResult = {
        file,
        state: outcome === 'skip' ? 'skip' : 'fail',
        durationMs: 9,
        errors: [],
      }
      await reporter['file:end']?.(fileResult)
    }
    await reporter['run:end']?.(SUMMARY)

    const aggregated = results.aggregated()
    assert.equal(aggregated.numTotalTestSuites, 2)
    assert.deepEqual(
      aggregated.testResults.map((entry) => entry.testFilePath),
      ['/proj/b.test.ts', '/proj/a.test.ts'],
    )
    assert.deepEqual(
      [
        aggregated.numTotalTests,
        aggregated.numPassedTests,
        aggregated.numFailedTests,
        aggregated.numPendingTests,
        aggregated.numPendingTestSuites,
        aggregated.numFailedTestSuites,
      ],
      [3, 1, 1, 1, 1, 1],
    )
    assert.equal(aggregated.success, false)
    assert.equal(aggregated.wasInterrupted, false)
    const failedFile = results.testResultOf(a.fileId)
    assert.match(failedFile?.failureMessage ?? '', /● suite › breaks/)
    assert.match(failedFile?.failureMessage ?? '', /nope/)
    assert.equal(failedFile?.displayName?.name, 'unit')
    assert.equal(failedFile?.testResults[1]?.location?.line, 2)
    assert.equal(results.testResultOf(b.fileId)?.skipped, true)
    assert.equal(results.testOf(a).path, '/proj/a.test.ts')
    assert.equal(results.contexts().size, 1)
  })

  it('runs again from run:start with nothing left over', async () => {
    const results = createJestResults({
      globalConfig: { noStackTrace: true },
      projectConfigs: [config],
    })
    await results.reporter['run:start']?.(
      { root: '/proj', projects: ['p'], startTime: 0, watch: false },
      [],
    )
    await results.reporter['run:end']?.({ ...SUMMARY, reason: 'passed', files: [] })
    // A reporter's `onRunComplete` hears `success: false` (Jest computes it afterwards); settled here.
    assert.equal(results.aggregated().success, false)
    results.reportersFailed(false)
    assert.equal(results.aggregated().success, true)
    results.reportersFailed(true)
    assert.equal(results.aggregated().success, false)
    assert.equal(results.aggregated().numTotalTestSuites, 0)
    assert.deepEqual(results.aggregated().testResults, [])
  })

  /** Plays one file: its tests (with each one's result), the file's unhandled errors, its end. */
  async function playFile(
    results: ReturnType<typeof createJestResults>,
    file: FileInfo,
    tests: readonly { task: TestTask; result: ReturnType<typeof resultOf> }[],
    options: {
      unhandled?: { ownerId: TaskId | null; error: SerializedError }[]
      retried?: Record<string, SerializedError[]>
    } = {},
  ): Promise<void> {
    const { reporter } = results
    const root: FileTask = {
      type: 'file',
      id: file.fileId,
      parentId: null,
      fileId: file.fileId,
      name: file.path,
      mode: 'run',
      location: null,
      tags: [],
      meta: {},
      path: file.path,
      projectName: 'p',
      children: tests.map((entry) => entry.task.id),
    }
    await reporter['file:start']?.(file, 1)
    await reporter['file:collected']?.(file, {
      type: 'file-collect-end',
      fileId: file.fileId,
      tasks: [root, ...tests.map((entry) => entry.task)],
      errors: [],
      t: 0,
    })
    for (const { task, result } of tests) {
      await reporter['task:start']?.(task, { type: 'test-start', id: task.id, t: 0 })
      for (const error of options.retried?.[task.id] ?? []) {
        await reporter['test:attempt-end']?.(task, {
          type: 'test-attempt-end',
          id: task.id,
          attempt: 1,
          errors: [error],
          willRetry: true,
          t: 0,
        } as never)
      }
      await reporter['task:end']?.(task, { type: 'test-end', id: task.id, result, t: 0 })
    }
    for (const entry of options.unhandled ?? []) {
      await reporter.unhandled?.(file, {
        type: 'unhandled-error',
        ownerId: entry.ownerId,
        lastTestId: null,
        origin: 'uncaught-exception',
        error: entry.error,
        t: 0,
      } as never)
    }
    await reporter['file:end']?.({
      file,
      state: tests.some((entry) => entry.result.state === 'fail') ? 'fail' : 'pass',
      durationMs: 1,
      errors: [],
    })
  }

  const fresh = () =>
    createJestResults({ globalConfig: { noStackTrace: true }, projectConfigs: [config] })
  const retry = (message: string): SerializedError => ({
    name: 'Error',
    message,
    stack: `Error: ${message}\n    at t (/proj/a.test.ts:2:3)`,
  })

  it('fills retryReasons and retryMessages only when the result kept the earlier errors (logErrorsBeforeRetry)', async () => {
    for (const keeps of [false, true]) {
      const results = fresh()
      const task = testOf('a.test.ts', 'flaky')
      await playFile(
        results,
        infoOf('a.test.ts'),
        [
          {
            task,
            result: {
              ...resultOf('pass'),
              attempts: 2,
              retryErrors: keeps ? [retry('first')] : [],
            },
          },
        ],
        { retried: { [task.id]: [retry('first')] } },
      )
      const [assertion] = results.testResultOf(id('a.test.ts'))?.testResults ?? []
      assert.equal(assertion?.retryReasons?.length, keeps ? 1 : 0, `keeps ${keeps}`)
      assert.equal(assertion?.retryMessages?.length, keeps ? 1 : 0, `keeps ${keeps}`)
    }
  })

  it('pairs retryMessages with the test that was retried when two tests share a full name', async () => {
    const results = fresh()
    const first = { ...testOf('a.test.ts', 'same'), id: id('a.test.ts:same#0') }
    const second = { ...testOf('a.test.ts', 'same'), id: id('a.test.ts:same#1') }
    await playFile(results, infoOf('a.test.ts'), [
      { task: first, result: resultOf('pass') },
      { task: second, result: { ...resultOf('pass'), retryErrors: [retry('only the second')] } },
    ])
    const [one, two] = results.testResultOf(id('a.test.ts'))?.testResults ?? []
    assert.deepEqual(one?.retryMessages, [])
    assert.equal(two?.retryMessages?.length, 1)
    assert.match(two?.retryMessages?.[0] ?? '', /only the second/)
  })

  it('charges an unhandled error to the running file only when it is the file’s or one of its tests’', async () => {
    const results = fresh()
    const other = testOf('b.test.ts', 'elsewhere')
    const own = testOf('a.test.ts', 'here')
    await playFile(results, infoOf('a.test.ts'), [{ task: own, result: resultOf('pass') }], {
      unhandled: [{ ownerId: other.id, error: retry('belongs to b') }],
    })
    const stray = results.testResultOf(id('a.test.ts'))
    assert.equal(stray?.testExecError, undefined)
    assert.equal(results.aggregated().numRuntimeErrorTestSuites, 0)

    const mine = fresh()
    await playFile(mine, infoOf('a.test.ts'), [{ task: own, result: resultOf('pass') }], {
      unhandled: [
        { ownerId: own.id, error: retry('in a test') },
        { ownerId: null, error: retry('in the run') },
      ],
    })
    assert.ok(mine.testResultOf(id('a.test.ts'))?.testExecError !== undefined)
  })

  it('formats a file that could not load with Jest’s text', async () => {
    const results = createJestResults({
      globalConfig: { noStackTrace: true },
      projectConfigs: [config],
    })
    const file = infoOf('load.test.ts', 0)
    await results.reporter['file:start']?.(file, 1)
    await results.reporter['file:end']?.({
      file,
      state: 'fail',
      durationMs: 1,
      errors: [{ name: 'Error', message: 'cannot load', stack: 'Error: cannot load' }],
    })
    const built = results.testResultOf(file.fileId)
    assert.equal(built?.testExecError?.message, 'cannot load')
    assert.match(built?.failureMessage ?? '', /Test suite failed to run/)
    assert.equal(results.aggregated().numRuntimeErrorTestSuites, 1)
  })
})
