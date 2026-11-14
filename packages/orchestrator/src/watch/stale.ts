// T9.11: what a warm worker must forget after a change. Each live worker has the set of changed
// paths it has not been told about; the set goes with its next file (`FileJob.staleModules`, which
// the worker's runner hands to `loader.dropRecords` before the file starts) and is cleared. Some
// changes can't be forgotten that way, and the workers are replaced instead (`retirementFor`).
import { basename } from 'node:path'
import type { WorkerKey } from '@provino/types'
import type { WatchEvent } from './coalesce.ts'

/**
 * The changed paths each live worker has not been told about.
 * @internal
 */
export interface StaleModules {
  /** A worker is starting: from now on it hears of every change. */
  register(workerId: number): void
  /** A worker is gone (it exited, or never started). */
  forget(workerId: number): void
  /** These absolute paths changed: every live worker must drop its records of them. */
  changed(paths: Iterable<string>): void
  /** The paths `workerId` has not been told about, which it is told now: the set is cleared. */
  take(workerId: number): readonly string[]
  /** How many workers it tracks (a test reads it). */
  readonly size: () => number
}

/** @internal */
export function createStaleModules(): StaleModules {
  const byWorker = new Map<number, Set<string>>()
  return {
    register(workerId) {
      if (!byWorker.has(workerId)) byWorker.set(workerId, new Set())
    },
    forget(workerId) {
      byWorker.delete(workerId)
    },
    changed(paths) {
      const list = [...paths]
      for (const set of byWorker.values()) for (const path of list) set.add(path)
    },
    take(workerId) {
      const set = byWorker.get(workerId)
      if (set === undefined || set.size === 0) return []
      const paths = [...set].sort()
      set.clear()
      return paths
    },
    size: () => byWorker.size,
  }
}

/**
 * Which workers a batch of changes retires rather than tells, or `undefined` for none:
 * - every worker, after an `add` or an `unlink` (a resolution the worker made, or the root
 *   `__mocks__` index it built at boot, may name a file that is gone or miss one that is new) or a
 *   `package.json` change (its `exports`, `main` and `imports` steer resolution);
 * - a worker at isolation tier `none`, after any change: it shares module instances across files,
 *   and dropping a record doesn't reach an instance another module already holds.
 * @internal
 */
export function retirementFor(
  batch: readonly WatchEvent[],
): ((key: WorkerKey) => boolean) | undefined {
  if (batch.length === 0) return undefined
  const everything = batch.some(
    (event) => event.kind !== 'change' || basename(event.path) === 'package.json',
  )
  return everything ? () => true : (key) => key.isolation === 'none'
}
