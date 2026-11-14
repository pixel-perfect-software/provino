// Whether a run goes in band: its files run in the coordinator's own process, one at a time (the
// `inline` pool). Jest's `shouldRunInBand` (jest-core `testSchedulerHelper.ts` L12-L79), with its
// numbers from the policy's `orchestrator.inBand`.
import type { OrchestratorPolicy } from '@provino/types'

/**
 * What `shouldRunInBand` reads. An options object, so a caller can add to it (watch mode, which
 * Jest never runs in band) without a new signature.
 * @public
 */
export interface InBandInput {
  /** The policy's `orchestrator.inBand`; `single: false` and `fastFileCount: 0` leave the choice to the caller. */
  readonly policy: OrchestratorPolicy['inBand']
  /** The caller asked for it (`-i`). Always in band. */
  readonly runInBand?: boolean
  /** Open handles are found in this process, so the run is in band. Always in band. */
  readonly detectOpenHandles?: boolean
  /** A watch run is never in band unless asked: the terminal stays responsive. */
  readonly watch?: boolean
  /** A memory limit for the workers is set: workers are needed, so the run isn't in band by itself. */
  readonly workerMemoryLimit?: boolean
  /** The worker count the run would use. */
  readonly maxWorkers: number
  /** How many files the run has (after the filters and the shard). */
  readonly fileCount: number
  /** The cached run time of each file that has one (a file with none is left out), in ms. */
  readonly timingsMs: readonly number[]
}

/**
 * Whether the run goes in band. Asked for, or `detectOpenHandles`: yes. Watch mode: no. Otherwise,
 * under the policy: yes when no memory limit is set and the run has one worker or at
 * most one file (`single`), or at most `fastFileCount` files of which some have a cached time and
 * every cached time is under `slowMs`.
 * @public
 */
export function shouldRunInBand(input: InBandInput): boolean {
  if (input.runInBand === true || input.detectOpenHandles === true) return true
  const { policy } = input
  if (input.watch === true || input.workerMemoryLimit === true) return false
  if (policy.single && (input.maxWorkers <= 1 || input.fileCount <= 1)) return true
  return (
    input.fileCount <= policy.fastFileCount &&
    input.timingsMs.length > 0 &&
    input.timingsMs.every((time) => time < policy.slowMs)
  )
}
