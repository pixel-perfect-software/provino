import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  MatcherState,
  RuntimeEvent,
  TaskId,
  TaskResult,
  TaskState,
  TestTask,
} from '@provino/types'
import { summarizeExpectRun } from './run-expect.ts'

const FILE_ID = 'file' as TaskId

function testTask(name: string): TestTask {
  return {
    type: 'test',
    id: `test-${name}` as TaskId,
    parentId: FILE_ID,
    fileId: FILE_ID,
    name,
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
    fullName: [name],
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail: false,
    timeoutMs: 5000,
    retry: 1,
    repeats: 0,
  }
}

function resultOf(state: TaskState): TaskResult {
  return {
    state,
    durationMs: 0,
    startTime: 0,
    errors: [],
    retryErrors: [],
    attempts: 1,
    repeatIndex: 0,
    assertions: 0,
    passingAssertions: 0,
  }
}

function attemptEnd(id: TaskId, attempt: number): RuntimeEvent {
  return {
    type: 'test-attempt-end',
    id,
    attempt,
    repeat: 0,
    state: 'pass',
    errors: [],
    willRetry: false,
    t: 0,
  }
}

const state = (numPassingAsserts: number): MatcherState => ({
  assertionCalls: numPassingAsserts,
  expectedAssertionsNumber: null,
  isExpectingAssertions: false,
  numPassingAsserts,
  pendingAsync: new Set(),
  suppressedErrors: [],
})

test('the passing count is the deciding run`s: the last attempt, not an earlier one', () => {
  const retried = testTask('retried')
  const events: RuntimeEvent[] = [
    { type: 'file-collect-end', fileId: FILE_ID, tasks: [retried], errors: [], t: 0 },
    attemptEnd(retried.id, 0),
    attemptEnd(retried.id, 1),
    { type: 'test-end', id: retried.id, result: resultOf('pass'), t: 0 },
  ]
  const [summary] = summarizeExpectRun(events, (_id, run) =>
    run.attempt === 0 ? state(1) : undefined,
  )
  assert.equal(summary?.passingAssertions, 0)
})

test('a test that ran but reported no attempt fails the check instead of counting 0', () => {
  const lost = testTask('lost')
  const events: RuntimeEvent[] = [
    { type: 'file-collect-end', fileId: FILE_ID, tasks: [lost], errors: [], t: 0 },
    { type: 'test-end', id: lost.id, result: resultOf('fail'), t: 0 },
  ]
  assert.throws(() => summarizeExpectRun(events, () => undefined), /ended with no attempt/)
})

test('a skipped or todo test needs no attempt', () => {
  const skipped = testTask('skipped')
  const todo = testTask('todo')
  const events: RuntimeEvent[] = [
    { type: 'file-collect-end', fileId: FILE_ID, tasks: [skipped, todo], errors: [], t: 0 },
    { type: 'test-end', id: skipped.id, result: resultOf('skip'), t: 0 },
    { type: 'test-end', id: todo.id, result: resultOf('todo'), t: 0 },
  ]
  const summaries = summarizeExpectRun(events, () => undefined)
  assert.deepEqual(
    summaries.map((s) => [s.status, s.passingAssertions]),
    [
      ['skipped', 0],
      ['todo', 0],
    ],
  )
})
