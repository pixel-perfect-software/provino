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

function resultOf(state: 'pass' | 'fail' | 'skip', errors: SerializedError[] = []) {
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
  } as const
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
    assert.equal(results.aggregated().success, true)
    assert.equal(results.aggregated().numTotalTestSuites, 0)
    assert.deepEqual(results.aggregated().testResults, [])
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
