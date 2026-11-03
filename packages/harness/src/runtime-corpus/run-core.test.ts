// `summarizeRun` reduces the events the core emits for one file. No core runs here: the events are
// built by hand, so each case says exactly what the core reported.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  RuntimeEvent,
  SerializedError,
  SourceLocation,
  TaskId,
  TaskNode,
  TaskResult,
  TaskState,
  TestTask,
} from '@provino/types'
import { summarizeRun } from './run-core.ts'

const FILE_ID = 'file' as TaskId
const boom: SerializedError = { name: 'Error', message: 'boom' }

function testTask(name: string, location: SourceLocation | null = null): TestTask {
  return {
    type: 'test',
    id: `test-${name}` as TaskId,
    parentId: FILE_ID,
    fileId: FILE_ID,
    name,
    mode: 'run',
    location,
    tags: [],
    meta: {},
    fullName: [name],
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail: false,
    timeoutMs: 5000,
    retry: 0,
    repeats: 0,
  }
}

function resultOf(state: TaskState, errors: readonly SerializedError[] = []): TaskResult {
  return {
    state,
    durationMs: 0,
    startTime: 0,
    errors,
    retryErrors: [],
    attempts: 1,
    repeatIndex: 0,
    assertions: 0,
    passingAssertions: 0,
  }
}

function collectEnd(
  tasks: readonly TaskNode[],
  errors: readonly SerializedError[] = [],
): RuntimeEvent {
  return { type: 'file-collect-end', fileId: FILE_ID, tasks, errors, t: 0 }
}

function testEnd(
  task: TestTask,
  state: TaskState,
  errors: readonly SerializedError[] = [],
): RuntimeEvent {
  return { type: 'test-end', id: task.id, result: resultOf(state, errors), t: 0 }
}

function fileEnd(state: TaskState, errors: readonly SerializedError[] = []): RuntimeEvent {
  return { type: 'file-end', fileId: FILE_ID, result: resultOf(state, errors), t: 0 }
}

test('a test takes its status from its test-end, and carries that result’s errors', () => {
  const pass = testTask('pass')
  const fail = testTask('fail', { file: 'a.test.ts', line: 4, column: 3 })
  const skip = testTask('skip')
  const todo = testTask('todo')
  const run = summarizeRun(
    [
      collectEnd([pass, fail, skip, todo]),
      testEnd(pass, 'pass'),
      testEnd(fail, 'fail', [boom]),
      testEnd(skip, 'skip'),
      testEnd(todo, 'todo'),
      fileEnd('fail'),
    ],
    ['step'],
  )
  assert.deepEqual(
    run.tests.map((t) => [t.path, t.status, t.errors, t.location]),
    [
      [['pass'], 'passed', [], null],
      [['fail'], 'failed', [boom], { line: 4, column: 3 }],
      [['skip'], 'skipped', [], null],
      [['todo'], 'todo', [], null],
    ],
  )
  assert.deepEqual(run.trace, ['step'])
})

test('a collected test with no test-end is no-result, not skipped', () => {
  const ended = testTask('ended')
  const dropped = testTask('dropped')
  const run = summarizeRun(
    [collectEnd([ended, dropped]), testEnd(ended, 'pass'), fileEnd('pass')],
    [],
  )
  assert.deepEqual(
    run.tests.map((t) => t.status),
    ['passed', 'no-result'],
  )
})

test('a test-end that leaves the test queued or running is no-result too', () => {
  const queued = testTask('queued')
  const running = testTask('running')
  const run = summarizeRun(
    [collectEnd([queued, running]), testEnd(queued, 'queued'), testEnd(running, 'running')],
    [],
  )
  assert.deepEqual(
    run.tests.map((t) => t.status),
    ['no-result', 'no-result'],
  )
})

test('the file status is named for every file-end state, and a missing file-end is no-result', () => {
  const states: ReadonlyArray<[TaskState, string]> = [
    ['pass', 'passed'],
    ['fail', 'failed'],
    ['skip', 'skipped'],
    // The result model has no file status for a file of only todos, so this matches no golden.
    ['todo', 'todo'],
    ['queued', 'no-result'],
    ['running', 'no-result'],
  ]
  for (const [state, status] of states) {
    const task = testTask('t')
    const run = summarizeRun([collectEnd([task]), testEnd(task, 'pass'), fileEnd(state)], [])
    assert.equal(run.fileStatus, status, state)
  }
  const task = testTask('t')
  assert.equal(
    summarizeRun([collectEnd([task]), testEnd(task, 'pass')], []).fileStatus,
    'no-result',
  )
})

test('a failed file with no tasks and a collection error is crashed', () => {
  const collection: SerializedError = { name: 'CoreError', message: 'no fn', code: 'CORE_X' }
  const crashed = summarizeRun([collectEnd([], [collection]), fileEnd('fail', [collection])], [])
  assert.equal(crashed.fileStatus, 'crashed')
  assert.deepEqual(crashed.collectionErrors, [collection])
  assert.deepEqual(crashed.fileErrors, [collection])

  // Without a collection error the file failed in its hooks, not at collection.
  const failed = summarizeRun([collectEnd([]), fileEnd('fail', [boom])], [])
  assert.equal(failed.fileStatus, 'failed')
  assert.deepEqual(failed.collectionErrors, [])
  assert.deepEqual(failed.fileErrors, [boom])

  // With a task the file ran, so a collection error does not make it a crash.
  const task = testTask('t')
  const ran = summarizeRun(
    [collectEnd([task], [collection]), testEnd(task, 'pass'), fileEnd('fail', [collection])],
    [],
  )
  assert.equal(ran.fileStatus, 'failed')
})

test('a run with no events has nothing in it, and its file is no-result', () => {
  const run = summarizeRun([], [])
  assert.deepEqual(run.tests, [])
  assert.deepEqual(run.fileErrors, [])
  assert.deepEqual(run.collectionErrors, [])
  assert.equal(run.fileStatus, 'no-result')
})
