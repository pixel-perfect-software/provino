import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileInfo } from '@provino/types'
import { fileInfo } from '../../internal/test-support.ts'
import { createEstimator } from './estimate.ts'
import { createRunState, RING_CAPACITY, SLOWEST } from './state.ts'

function result(file: FileInfo, durationMs = 1, state: 'pass' | 'fail' | 'skip' = 'pass') {
  return { file, state, durationMs, errors: [] } as const
}

// A run in band announces the next file on the same worker before the last one has ended (B26
// Phase 3), so the old file keeps its record, and its counts, until its own `file:end`; `finish`
// releases one that never ends.
test('a worker slot that is reused shows the new file, the old one keeps its record until it ends, and a late end clears nothing', () => {
  const state = createRunState()
  const a = fileInfo('a.test.ts')
  const b = fileInfo('b.test.ts')
  state.start([a, b], 0)
  state.fileStart(a, 0, 1)
  state.testEnd(a.fileId, 'pass')
  state.fileStart(b, 0, 2)
  assert.equal(state.busy(), 1)
  assert.equal(state.workers()[0]?.path, 'b.test.ts')
  assert.equal(state.running(), 2, 'a has not ended yet')
  state.fileEnd(result(a))
  assert.equal(state.take()[0]?.tests, 1, 'a keeps its test')
  assert.equal(state.busy(), 1)
  assert.equal(state.workers()[0]?.path, 'b.test.ts')
  assert.equal(state.running(), 1)
  state.fileEnd(result(b))
  assert.equal(state.busy(), 0)
  assert.equal(state.running(), 0)
})

test('counts by outcome, per running file', () => {
  const state = createRunState()
  const a = fileInfo('a.test.ts')
  state.start([a], 10)
  state.fileStart(a, 0, 11)
  state.testEnd(a.fileId, 'pass')
  state.testEnd(a.fileId, 'fail')
  state.testEnd(a.fileId, 'skip')
  state.testEnd(a.fileId, 'todo')
  state.testEnd(a.fileId, 'running')
  assert.deepEqual({ ...state.counts }, { passed: 1, failed: 1, skipped: 1, todo: 1 })
  assert.equal(state.workers()[0]?.tests, 4)
  assert.equal(state.workers()[0]?.failed, 1)
  assert.equal(state.busy(), 1)
  assert.equal(state.startedAt(), 10)
})

test('a file ending frees its slot and joins the ring once', () => {
  const state = createRunState()
  const a = fileInfo('a.test.ts')
  const b = fileInfo('b.test.ts')
  state.start([a, b], 0)
  state.fileStart(a, 0, 1)
  state.fileStart(b, 1, 1)
  state.testEnd(a.fileId, 'fail')
  state.fileEnd(result(a, 5, 'fail'))
  assert.equal(state.busy(), 1)
  assert.equal(state.workers()[0], undefined)
  assert.equal(state.workers()[1]?.path, 'b.test.ts')
  assert.equal(state.filesDone(), 1)
  assert.equal(state.filesFailed(), 1)
  const taken = state.take()
  assert.equal(taken.length, 1)
  assert.equal(taken[0]?.failed, 1)
  assert.equal(state.take().length, 0)
})

test('the ring is bounded: the oldest are counted when no frame comes', () => {
  const state = createRunState()
  const files = Array.from({ length: RING_CAPACITY + 10 }, (_, i) => fileInfo(`f${i}.test.ts`))
  state.start(files, 0)
  for (const file of files) {
    state.fileStart(file, 0, 0)
    state.fileEnd(result(file))
  }
  assert.equal(state.dropped(), 10)
  const taken = state.take()
  assert.equal(taken.length, RING_CAPACITY)
  assert.equal(taken[0]?.result.file.path, 'f10.test.ts')
  assert.equal(state.dropped(), 0)
})

test('the slowest files are a fixed top five, longest first', () => {
  const state = createRunState()
  const files = Array.from({ length: 20 }, (_, i) => fileInfo(`f${i}.test.ts`))
  state.start(files, 0)
  files.forEach((file, i) => {
    state.fileStart(file, 0, 0)
    state.fileEnd(result(file, (i * 7) % 20))
  })
  const slow = state.slowest()
  assert.equal(slow.length, SLOWEST)
  assert.deepEqual(
    slow.map((file) => file.durationMs),
    [19, 18, 17, 16, 15],
  )
})

test('dirty is set by every change and cleared by clean', () => {
  const state = createRunState()
  assert.equal(state.dirty(), false)
  state.start([], 0)
  assert.equal(state.dirty(), true)
  state.clean()
  state.error()
  assert.equal(state.dirty(), true)
  assert.equal(state.errors(), 1)
})

test('start resets everything', () => {
  const state = createRunState()
  const a = fileInfo('a.test.ts')
  state.start([a], 0)
  state.fileStart(a, 3, 0)
  state.testEnd(a.fileId, 'pass')
  state.fileEnd(result(a))
  state.start([a], 5)
  assert.equal(state.counts.passed, 0)
  assert.equal(state.filesDone(), 0)
  assert.equal(state.busy(), 0)
  assert.equal(state.take().length, 0)
  assert.equal(state.slowest().length, 0)
})

function files(expected: readonly (number | undefined)[]): FileInfo[] {
  return expected.map((_, i) => fileInfo(`f${i}.test.ts`))
}

test('time left: expected time of the files not ended, less what the running files have had, over busy workers', () => {
  const list = files([1000, 1000, 1000, 1000])
  const expected = new Map(list.map((file) => [file.fileId, 1000]))
  const estimator = createEstimator((file) => expected.get(file.fileId))
  estimator.reset(list)
  const [a, b] = list as [FileInfo, FileInfo]
  estimator.fileStarted(a, 0, 1)
  estimator.fileStarted(b, 0, 2)
  // 4000 expected, none done, no time yet, two workers: 2000.
  assert.equal(estimator.leftMs(0), 2000)
  // The value counts down with the clock between events.
  assert.equal(estimator.leftMs(500), 1500)
  estimator.fileEnded(a, 1000, 1)
  // 3000 expected, b has had 1000: 2000 over one worker.
  assert.equal(estimator.leftMs(1000), 2000)
  assert.equal(estimator.leftMs(9000), 0)
})

test('a file with no expectation counts as the median of those with one', () => {
  const list = files([100, 300, undefined, undefined])
  const expected = new Map<string, number>([
    [list[0]?.fileId as string, 100],
    [list[1]?.fileId as string, 300],
  ])
  const estimator = createEstimator((file) => expected.get(file.fileId))
  estimator.reset(list)
  estimator.fileStarted(list[0] as FileInfo, 0, 1)
  // 100 + 300 + 2 x median(100, 300) = 800, over one worker.
  assert.equal(estimator.leftMs(0), 800)
})

test('shown only when at least half the files have an expectation', () => {
  const few = files([100, undefined, undefined])
  const estimator = createEstimator((file) => (file === few[0] ? 100 : undefined))
  estimator.reset(few)
  estimator.fileStarted(few[0] as FileInfo, 0, 1)
  assert.equal(estimator.leftMs(0), undefined)
  const half = files([100, undefined])
  const halfEstimator = createEstimator((file) => (file === half[0] ? 100 : undefined))
  halfEstimator.reset(half)
  halfEstimator.fileStarted(half[0] as FileInfo, 0, 1)
  assert.notEqual(halfEstimator.leftMs(0), undefined)
  assert.equal(createEstimator(() => undefined).leftMs(0), undefined)
})
