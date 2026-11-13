// T9.6: which files a shard runs (`--shard=i/n`). Two splits, both pure in (files, shard):
//
// - `sha1Shard`: Jest's and Vitest's. Sort by `sha1(path relative to the project root)`, then
//   take contiguous slices by file count (jest-test-sequencer 30.5.2 `shard`). No timings.
// - `sliceShard`: path-sorted, contiguous cuts by predicted time (Bun's `--timings` method, Track
//   9 §Sharding): a file the timings file has no time for counts as the median of the ones it has,
//   so a new file doesn't move the files around it. With no timings at all every file counts the
//   same, which is contiguous slices by file count.
//
// Every file lands in exactly one shard, for any input order: both sort first with a total order
// (path, then project), and a file's shard is a function of its place in that order.
import { hash } from 'node:crypto'
import { join } from 'node:path'
import type { ScheduleInput, TimingsFile } from '@provino/types'
import type { DiscoveredFile } from './discover.ts'
import { OrchestratorError } from './errors.ts'
import { relativePosix } from './file-id.ts'
import { byText } from './util.ts'

/**
 * Which shard to run: `index` is 1-based, as `--shard=2/3` writes it.
 * @public
 */
export interface ShardSpec {
  readonly index: number
  readonly count: number
}

/** A weight below this counts as this, so a file with a 0 ms time still has a place in the cumulative sum. */
const MIN_WEIGHT_MS = 1

/**
 * Throws `ORCH_BAD_OPTION` unless `shard` is `index` of `count`, both whole numbers, with
 * `1 <= index <= count`. Jest's text for each (`parseShardPair`) is the dialect reader's.
 * @public
 */
export function checkShard(shard: ShardSpec): void {
  const { index, count } = shard
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      `shard.count (how many shards the files are split into) must be a whole number of at least 1 (got ${String(count)})`,
    )
  }
  if (!Number.isSafeInteger(index) || index < 1 || index > count) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      `shard.index (which shard this run is, 1-based) must be a whole number from 1 to ${String(count)} (got ${String(index)})`,
    )
  }
}

/** Path, then project: a total order, so no input order changes a shard. */
function byPathThenProject(a: ScheduleInput, b: ScheduleInput): number {
  return byText(a.path, b.path) || byText(a.project, b.project)
}

/** How many files shard `position` (0-based) holds out of `total`: the first `total % count` shards hold one more. */
function sizeOf(position: number, total: number, count: number): number {
  return Math.floor(total / count) + (position < total % count ? 1 : 0)
}

/**
 * Jest's split: the files sorted by the sha1 of their path relative to their project's root, then
 * the `index`-th contiguous slice, the first `files.length % count` slices one file longer
 * (`TestSequencer.shard`). The hash is of `ScheduleInput.path`, which is that relative path with
 * `/`. Two files with the same path in different projects hash alike: the project breaks the tie
 * (Jest's stable sort leaves them in discovery order).
 * @public
 */
export function sha1Shard(
  files: readonly ScheduleInput[],
  shard: ShardSpec,
): readonly ScheduleInput[] {
  checkShard(shard)
  const hashed = files
    .toSorted(byPathThenProject)
    .map((file) => ({ file, hash: hash('sha1', file.path) }))
    .toSorted((a, b) => byText(a.hash, b.hash))
  let start = 0
  for (let position = 0; position < shard.index - 1; position++) {
    start += sizeOf(position, hashed.length, shard.count)
  }
  const end = start + sizeOf(shard.index - 1, hashed.length, shard.count)
  return hashed.slice(start, end).map((entry) => entry.file)
}

/**
 * What each file is predicted to take, in ms: its `timingMs`, else the median of the files that
 * have one, else 1 (nothing is known, so every file counts the same).
 * @public
 */
export function predictedWeights(
  files: readonly ScheduleInput[],
): ReadonlyMap<ScheduleInput, number> {
  const known = files
    .flatMap((file) =>
      file.timingMs === undefined ? [] : [Math.max(file.timingMs, MIN_WEIGHT_MS)],
    )
    .toSorted((a, b) => a - b)
  const middle = Math.floor(known.length / 2)
  const median =
    known.length === 0
      ? 1
      : known.length % 2 === 1
        ? (known[middle] as number)
        : ((known[middle - 1] as number) + (known[middle] as number)) / 2
  return new Map(
    files.map((file) => [
      file,
      file.timingMs === undefined ? median : Math.max(file.timingMs, MIN_WEIGHT_MS),
    ]),
  )
}

/**
 * Path-sorted, contiguous cuts by predicted time: the files sorted by path (then project), each
 * placed by the middle of its own span of the cumulative time, shard `floor(count * middle /
 * total)`. A shard is a run of neighbouring files, so files that share modules share a worker and
 * a shard's caches stay warm from one CI run to the next, and a file's shard only moves when the
 * time before it changes enough to cross a cut. The shards come out in path order.
 * @public
 */
export function sliceShard(
  files: readonly ScheduleInput[],
  shard: ShardSpec,
): readonly ScheduleInput[] {
  checkShard(shard)
  const weights = predictedWeights(files)
  const sorted = files.toSorted(byPathThenProject)
  let total = 0
  for (const file of sorted) total += weights.get(file) as number
  const kept: ScheduleInput[] = []
  let before = 0
  for (const file of sorted) {
    const weight = weights.get(file) as number
    const middle = before + weight / 2
    before += weight
    const position = Math.min(shard.count - 1, Math.floor((shard.count * middle) / total))
    if (position === shard.index - 1) kept.push(file)
  }
  return kept
}

/**
 * The shard of `files` a run takes, whatever the dialect: contiguous cuts by predicted time as soon
 * as any file has a time (a timings file), else the dialect's `fallback` (`orchestrator.shard
 * .fallback`): `sha1-slice`, Jest's split, or `path-slice`, slices of the path-sorted files by
 * count.
 * @public
 */
export function shardInputs(
  files: readonly ScheduleInput[],
  shard: ShardSpec,
  fallback: 'sha1-slice' | 'path-slice',
): readonly ScheduleInput[] {
  const timed = files.some((file) => file.timingMs !== undefined)
  return !timed && fallback === 'sha1-slice' ? sha1Shard(files, shard) : sliceShard(files, shard)
}

/**
 * One project's discovered files, for `shardFiles`: `key` names the project among the run's (two
 * projects may share a name), `rootDir` is what a file's path is relative to.
 * @public
 */
export interface ShardMember {
  readonly key: string
  readonly rootDir: string
  readonly files: readonly DiscoveredFile[]
}

/**
 * The files each project runs of shard `shard` of the whole run: Jest shards one list across all
 * its projects, after the file filters, so this does too. Returns each member's kept files, in the
 * members' order and each member's own order. `timings` is the committed file: a file is looked up
 * by its path relative to `runRoot`, with `/`.
 * @public
 */
export function shardFiles(
  members: readonly ShardMember[],
  options: {
    readonly shard: ShardSpec
    readonly fallback: 'sha1-slice' | 'path-slice'
    readonly runRoot: string
    readonly timings?: TimingsFile | undefined
  },
): DiscoveredFile[][] {
  const inputs = members.flatMap((member) =>
    member.files.map((file): ScheduleInput => {
      const timingMs =
        options.timings?.files[
          relativePosix(options.runRoot, join(member.rootDir, file.relativePath))
        ]
      return {
        path: file.relativePath,
        project: member.key,
        sizeBytes: file.sizeBytes,
        ...(timingMs === undefined ? {} : { timingMs }),
      }
    }),
  )
  const kept = new Set(
    shardInputs(inputs, options.shard, options.fallback).map(
      (input) => `${input.project}\0${input.path}`,
    ),
  )
  return members.map((member) =>
    member.files.filter((file) => kept.has(`${member.key}\0${file.relativePath}`)),
  )
}
