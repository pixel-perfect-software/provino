// What a worker sends of an instrumented file's coverage: the maps (`statementMap`, `fnMap`,
// `branchMap`) are the same for every file that loads it, so a worker sends them once per path and
// version (`hash`), and every later take of that file carries the counters only. The coordinator's
// `expandIstanbulData` puts the maps back.
import type { IstanbulFileCoverageData } from '@provino/types'

/**
 * One file's counters in a take whose maps went out earlier.
 * @public
 */
export interface IstanbulCounters {
  readonly path: string
  readonly hash?: string
  readonly s: Readonly<Record<string, number>>
  readonly f: Readonly<Record<string, number>>
  readonly b: Readonly<Record<string, readonly number[]>>
}

/**
 * A file's coverage as a take carries it: all of it the first time, counters after.
 * @public
 */
export type InternedCoverage = IstanbulFileCoverageData | IstanbulCounters

/**
 * Remembers which files' maps this worker has sent.
 * @public
 */
export interface MapInterner {
  /** The file's data in the form to send, noting that its maps have gone out. */
  compact(data: IstanbulFileCoverageData): InternedCoverage
  /** Whether the maps of this version of the file have gone out. */
  has(path: string, hash: string | undefined): boolean
}

/**
 * Creates an interner for one worker.
 * @public
 */
export function createMapInterner(): MapInterner {
  const sent = new Map<string, string | undefined>()
  return {
    has: (path, hash) => sent.has(path) && sent.get(path) === hash,
    compact(data) {
      if (sent.has(data.path) && sent.get(data.path) === data.hash) {
        const counters: IstanbulCounters = {
          path: data.path,
          ...(data.hash === undefined ? {} : { hash: data.hash }),
          s: data.s,
          f: data.f,
          b: data.b,
        }
        return counters
      }
      sent.set(data.path, data.hash)
      return data
    },
  }
}
