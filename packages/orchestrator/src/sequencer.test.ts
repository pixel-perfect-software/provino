// The history sequencer against Jest's `sort` cases (jest-test-sequencer's own tests): failed
// files first, files with no history before or after the ones that have it, size and duration
// descending, and a path tie-break so the order is total. The shard is `shard.test.ts`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FileHistory, ScheduleInput } from '@provino/types'
import { createHistorySequencer } from './sequencer.ts'

function history(durationMs: number, failed = false): FileHistory {
  return { durationMs, failed, tests: 1, at: 0 }
}

function file(path: string, sizeBytes: number, past?: FileHistory): ScheduleInput {
  return { path, project: 'p', sizeBytes, ...(past === undefined ? {} : { history: past }) }
}

function order(files: readonly ScheduleInput[], unknownFirst = true): string[] {
  return createHistorySequencer({ unknownFirst, shardFallback: 'sha1-slice' })
    .sort(files)
    .map((f) => f.path)
}

describe('createHistorySequencer.sort', () => {
  it('runs a file that failed last time first, whatever its size or duration', () => {
    assert.deepEqual(
      order([
        file('big', 9000),
        file('slow', 10, history(900)),
        file('failed', 1, history(1, true)),
      ]),
      ['failed', 'big', 'slow'],
    )
  })

  it('puts files with no history before the ones that have it (unknownFirst)', () => {
    assert.deepEqual(
      order([file('known', 10, history(500)), file('unknown-small', 5), file('unknown-big', 50)]),
      ['unknown-big', 'unknown-small', 'known'],
    )
  })

  it('puts files with no history after the ones that have it when unknownFirst is off', () => {
    assert.deepEqual(
      order(
        [
          file('unknown-big', 50),
          file('known-fast', 10, history(5)),
          file('known-slow', 1, history(500)),
        ],
        false,
      ),
      ['known-slow', 'known-fast', 'unknown-big'],
    )
  })

  it('orders files with no history by size, largest first', () => {
    assert.deepEqual(order([file('a', 1), file('b', 3), file('c', 2)]), ['b', 'c', 'a'])
  })

  it('orders files with history by duration, longest first, ignoring size', () => {
    assert.deepEqual(
      order([file('a', 900, history(1)), file('b', 1, history(30)), file('c', 5, history(10))]),
      ['b', 'c', 'a'],
    )
  })

  it('orders failed files among themselves by the same rules', () => {
    assert.deepEqual(
      order([
        file('failed-fast', 1, history(1, true)),
        file('ok-slow', 1, history(999)),
        file('failed-slow', 1, history(50, true)),
      ]),
      ['failed-slow', 'failed-fast', 'ok-slow'],
    )
  })

  it('breaks every tie by path, so the order does not depend on the input order', () => {
    const files = [
      file('c', 5),
      file('a', 5),
      file('b', 5),
      file('z', 5, history(7)),
      file('y', 5, history(7)),
    ]
    const expected = ['a', 'b', 'c', 'y', 'z']
    assert.deepEqual(order(files), expected)
    assert.deepEqual(order([...files].reverse()), expected)
  })

  it('breaks a path tie by project', () => {
    const sorted = createHistorySequencer({ unknownFirst: true, shardFallback: 'sha1-slice' }).sort(
      [
        { path: 'a', project: 'two', sizeBytes: 1 },
        { path: 'a', project: 'one', sizeBytes: 1 },
      ],
    )
    assert.deepEqual(
      sorted.map((f) => f.project),
      ['one', 'two'],
    )
  })

  it('returns a new array and leaves the input alone', () => {
    const input = [file('b', 1), file('a', 2)]
    const sorted = createHistorySequencer({ unknownFirst: true, shardFallback: 'sha1-slice' }).sort(
      input,
    )
    assert.notEqual(sorted, input)
    assert.deepEqual(
      input.map((f) => f.path),
      ['b', 'a'],
    )
  })
})
