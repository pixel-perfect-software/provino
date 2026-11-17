// Time left. The expected time of the files that have not ended (a file with no expectation counts
// as the median of those that have one), less the time the running files have already had, over
// the workers that are busy. Shown only when at least half the files have an expectation.
// Recomputed on `file:start` and `file:end` only; between them the view counts the stored value
// down with the clock.

import type { FileInfo, TaskId } from '@provino/types'

/**
 * Expected time left in a run.
 * @beta
 */
export interface Estimator {
  /** A run starts: sums the files' expected times, once (O(files)). */
  reset(files: readonly FileInfo[]): void
  /** A file started at `now`, with `busy` workers busy afterwards. */
  fileStarted(file: FileInfo, now: number, busy: number): void
  /** A file ended at `now`, with `busy` workers busy afterwards. */
  fileEnded(file: FileInfo, now: number, busy: number): void
  /** The expected time left at `now`, in ms, or `undefined` when there are too few expectations to say. */
  leftMs(now: number): number | undefined
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  values.sort((a, b) => a - b)
  const mid = values.length >> 1
  return values.length % 2 === 1
    ? (values[mid] as number)
    : ((values[mid - 1] as number) + (values[mid] as number)) / 2
}

/**
 * Creates an estimator. `expectedMs` is a file's expected time in ms, if it has one.
 * @beta
 */
export function createEstimator(expectedMs: (file: FileInfo) => number | undefined): Estimator {
  /** The expectations of the files that have not ended, by file. */
  const expected = new Map<TaskId, number>()
  /** When each running file started. */
  const running = new Map<TaskId, number>()
  let startSum = 0
  let fileCount = 0
  let withExpectation = 0
  let fallback = 0
  /** Expected ms of every file that has not ended, the fallback included. */
  let remaining = 0
  let base = 0
  let baseAt = 0

  const shown = (): boolean => fileCount > 0 && withExpectation * 2 >= fileCount

  function recompute(now: number, busy: number): void {
    const elapsed = running.size * now - startSum
    base = Math.max(0, remaining - elapsed) / Math.max(1, busy)
    baseAt = now
  }

  function ended(file: FileInfo): void {
    remaining -= expected.get(file.fileId) ?? fallback
    expected.delete(file.fileId)
  }

  return {
    reset(files) {
      expected.clear()
      running.clear()
      startSum = 0
      fileCount = files.length
      const known: number[] = []
      for (const file of files) {
        const ms = expectedMs(file)
        if (ms === undefined) continue
        expected.set(file.fileId, ms)
        known.push(ms)
      }
      withExpectation = known.length
      let sum = 0
      for (const ms of known) sum += ms
      fallback = median(known)
      remaining = sum + (fileCount - withExpectation) * fallback
      base = 0
      baseAt = 0
    },
    fileStarted(file, now, busy) {
      running.set(file.fileId, now)
      startSum += now
      recompute(now, busy)
    },
    fileEnded(file, now, busy) {
      const startedAt = running.get(file.fileId)
      if (startedAt !== undefined) {
        startSum -= startedAt
        running.delete(file.fileId)
      }
      ended(file)
      recompute(now, busy)
    },
    leftMs(now) {
      return shown() ? Math.max(0, base - (now - baseAt)) : undefined
    },
  }
}
