// The schedule simulation of Track 9 §Spikes C (`bench-schedule.mjs`, deleted), rebuilt from its
// description for `schedule-sim.test.ts` (T9.6, PLAN → Ground rules: a deleted spike is rebuilt from
// the doc). The model, as the doc states it: lognormal durations (median 300 ms, sigma 1.3, p99 about
// 20x the median), a prediction of each file = its last run x a 35% lognormal noise, 10% of the files
// new (no prediction), 4% failed last run, greedy pull scheduling (a free worker takes the next file
// of the queue), 40 seeded trials.
//
// What the doc leaves open, and what is chosen here (recorded in `docs/plan/bundles/B21.md`):
// - a file's size, which orders the files with no history: its duration x a lognormal noise of
//   sigma 0.8 ("big files tend to take longer", Jest's own reason for the rule);
// - the lower bound of a makespan: `max(total / workers, longest file)` (the oracle LPT row of the
//   doc's table sits at 1.001 of it);
// - "ideal" for a shard: the whole run's time divided by shards x workers;
// - "files moved": of the original files, the share whose shard changes when 5% more files (random
//   paths, no history) are added.
import type { ScheduleInput } from '@provino/types'
import { createHistorySequencer } from './sequencer.ts'
import type { ShardSpec } from './shard.ts'

/** A seeded generator (mulberry32): the same seed gives the same trial on every machine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A standard normal draw (Box-Muller). */
function normal(random: () => number): number {
  const u = 1 - random()
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** One simulated file: what it really takes, and what the last run said. */
export interface SimFile {
  readonly path: string
  /** The real duration, ms. */
  readonly actualMs: number
  /** What the cache or the timings file says: absent for a new file. */
  readonly predictedMs?: number
  readonly failed: boolean
  readonly sizeBytes: number
}

/** The model's parameters, as the doc gives them. */
export const MODEL = {
  medianMs: 300,
  sigma: 1.3,
  noiseSigma: 0.35,
  newShare: 0.1,
  failedShare: 0.04,
  sizeSigma: 0.8,
} as const

/** `count` files with random paths, so no order of the paths says anything about their duration. */
export function generateFiles(count: number, random: () => number, label = 'f'): SimFile[] {
  return Array.from({ length: count }, (_, index) => {
    const actualMs = MODEL.medianMs * Math.exp(MODEL.sigma * normal(random))
    const isNew = random() < MODEL.newShare
    const failed = random() < MODEL.failedShare
    const noise = Math.exp(MODEL.noiseSigma * normal(random))
    const sizeBytes = Math.max(
      1,
      Math.round(actualMs * 40 * Math.exp(MODEL.sizeSigma * normal(random))),
    )
    const path = `${label}${Math.floor(random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0')}-${index}.test.ts`
    return {
      path,
      actualMs,
      ...(isNew ? {} : { predictedMs: actualMs * noise }),
      failed,
      sizeBytes,
    }
  })
}

/** `file` as a new one: no history, no time. */
function unpredicted(file: SimFile): SimFile {
  const { predictedMs: _predicted, ...rest } = file
  return rest
}

/** A simulated file as the sequencer reads it: `history` for the local cache, `timingMs` for the timings file. */
export function asInput(file: SimFile, as: 'history' | 'timing'): ScheduleInput {
  const base = { path: file.path, project: 'p', sizeBytes: file.sizeBytes }
  if (file.predictedMs === undefined) return base
  return as === 'timing'
    ? { ...base, timingMs: file.predictedMs }
    : {
        ...base,
        history: { durationMs: file.predictedMs, failed: file.failed, tests: 1, at: 0 },
      }
}

/** Greedy pull: each of `workers` takes the next file of `queue` when it is free. The time the last one ends. */
export function makespan(queue: readonly SimFile[], workers: number): number {
  const free = new Array<number>(workers).fill(0)
  for (const file of queue) {
    let soonest = 0
    for (let worker = 1; worker < workers; worker++) {
      if ((free[worker] as number) < (free[soonest] as number)) soonest = worker
    }
    free[soonest] = (free[soonest] as number) + file.actualMs
  }
  return Math.max(...free)
}

/** `max(total / workers, longest)`: no schedule can end sooner. */
export function lowerBound(files: readonly SimFile[], workers: number): number {
  const total = files.reduce((sum, file) => sum + file.actualMs, 0)
  return Math.max(total / workers, ...files.map((file) => file.actualMs))
}

/**
 * The orders the doc's "File order" table compares (the ones the acceptance reads, and the
 * baselines): `alphabetical`; `history`, what the sequencer does (failed first, then files with no
 * history by size, then longest first: the doc's "Jest order"); `oracle`, longest real duration first.
 */
export type Order = 'alphabetical' | 'history' | 'oracle'

/** `files` in the order `order` runs them. */
export function orderOf(files: readonly SimFile[], order: Order): SimFile[] {
  if (order === 'alphabetical') return files.toSorted((a, b) => (a.path < b.path ? -1 : 1))
  if (order === 'oracle') return files.toSorted((a, b) => b.actualMs - a.actualMs)
  const byPath = new Map(files.map((file) => [file.path, file]))
  const sorted = createHistorySequencer({ unknownFirst: true, shardFallback: 'sha1-slice' }).sort(
    files.map((file) => asInput(file, 'history')),
  )
  return sorted.map((input) => byPath.get(input.path) as SimFile)
}

/** Makespan over the lower bound, for one trial of one order. */
export function orderRatio(files: readonly SimFile[], order: Order, workers: number): number {
  return makespan(orderOf(files, order), workers) / lowerBound(files, workers)
}

/** The strategies of the doc's "Sharding" table that the acceptance reads. */
export type ShardStrategy = 'sha1' | 'contiguous'

/** The shard (1-based) each file belongs to, under `strategy`: the real sequencer, fed the model's data. */
export function shardsOf(
  files: readonly SimFile[],
  count: number,
  strategy: ShardStrategy,
): Map<string, number> {
  const sequencer = createHistorySequencer({
    unknownFirst: true,
    shardFallback: 'sha1-slice',
  })
  const assigned = new Map<string, number>()
  for (let index = 1; index <= count; index++) {
    const spec: ShardSpec = { index, count }
    const inputs =
      strategy === 'sha1'
        ? files.map((file) => asInput(unpredicted(file), 'timing'))
        : files.map((file) => asInput(file, 'timing'))
    // With no timing on any file, the sequencer takes Jest's split; with timings, contiguous cuts.
    for (const input of sequencer.shard(inputs, spec)) assigned.set(input.path, index)
  }
  return assigned
}

/** The slowest shard's makespan (2 workers by default, ordered as Jest does) over the ideal: all the work / (shards x workers). */
export function shardRatio(
  files: readonly SimFile[],
  count: number,
  workers: number,
  strategy: ShardStrategy,
): number {
  const assigned = shardsOf(files, count, strategy)
  let slowest = 0
  for (let index = 1; index <= count; index++) {
    const mine = files.filter((file) => assigned.get(file.path) === index)
    slowest = Math.max(slowest, makespan(orderOf(mine, 'history'), workers))
  }
  const total = files.reduce((sum, file) => sum + file.actualMs, 0)
  return slowest / (total / (count * workers))
}

/** The share of `files` whose shard changes when `extra` more files (no history) join. */
export function movedShare(
  files: readonly SimFile[],
  extra: readonly SimFile[],
  count: number,
  strategy: ShardStrategy,
): number {
  const before = shardsOf(files, count, strategy)
  const added = extra.map(unpredicted)
  const after = shardsOf([...files, ...added], count, strategy)
  let moved = 0
  for (const file of files) if (before.get(file.path) !== after.get(file.path)) moved++
  return moved / files.length
}

/** The median of `values`. */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
