// T9.6's order: Jest's `TestSequencer.sort` (jest-test-sequencer), with a total order, and the
// shard (`shard.ts`).
import type { Sequencer } from '@provino/types'
import { shardInputs } from './shard.ts'
import { byText } from './util.ts'

/**
 * Options for `createHistorySequencer`.
 * @public
 */
export interface HistorySequencerOptions {
  /**
   * Whether files with no history run before the ones that have it (`orchestrator.sequence
   * .unknownFirst`; Jest runs them first). Either way, files with no history go largest first.
   */
  readonly unknownFirst: boolean
  /**
   * How `shard` splits the files when none has a time (`orchestrator.shard.fallback`). With a time
   * for any file, every dialect cuts contiguous slices of the path-sorted files by predicted time.
   */
  readonly shardFallback: 'sha1-slice' | 'path-slice'
}

/**
 * Jest's order, made deterministic. A file sorts earlier when:
 *
 * 1. its last run failed;
 * 2. it has no history (with `unknownFirst`; with it off, the files that have history go first);
 * 3. among files with no history, it is the larger one (bytes: big files tend to take longer);
 * 4. among files with history, its last run took longer (longest first keeps workers busy to the
 *    end);
 * 5. finally, its path sorts first (then its project). Jest's comparator has no such step, so
 *    equal files fall wherever the engine's sort leaves them; here they never do.
 *
 * `sort` returns a new array. `shard` is `sha1Shard` (Jest's split) or `sliceShard` (path order,
 * contiguous cuts by predicted time; by file count when no file has a time), as the options say.
 * It is pure in its arguments: the same files, shard and timings give the same files on every
 * machine.
 * @public
 */
export function createHistorySequencer(options: HistorySequencerOptions): Sequencer {
  const { unknownFirst, shardFallback } = options
  return {
    sort(files) {
      return files.toSorted((a, b) => {
        const failedA = a.history?.failed === true
        const failedB = b.history?.failed === true
        if (failedA !== failedB) return failedA ? -1 : 1
        const timedA = a.history !== undefined
        const timedB = b.history !== undefined
        // `timedA === unknownFirst` is "A is on the side that goes later".
        if (timedA !== timedB) return timedA === unknownFirst ? 1 : -1
        if (a.history !== undefined && b.history !== undefined) {
          if (a.history.durationMs !== b.history.durationMs) {
            return a.history.durationMs < b.history.durationMs ? 1 : -1
          }
        } else if (a.sizeBytes !== b.sizeBytes) {
          return a.sizeBytes < b.sizeBytes ? 1 : -1
        }
        return byText(a.path, b.path) || byText(a.project, b.project)
      })
    },
    shard: (files, shard) => shardInputs(files, shard, shardFallback),
  }
}
