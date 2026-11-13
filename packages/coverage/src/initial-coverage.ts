// Track 8 F9 (D110): the initial coverage an instrumented file carries (every counter zero), read
// from the instrumented code without running it. Jest's CoverageReporter does this for the files no
// test loaded (`readInitialCoverage` of `istanbul-lib-instrument`), and the Istanbul provider will too.
import type { IstanbulFileCoverageData } from '@provino/types'
import { readInitialCoverage as read } from './vendor/istanbul-lib-instrument/index.ts'

/**
 * What `readInitialCoverage` finds in instrumented code: the file's path, the hash of its data, the
 * function that finds the global, and the coverage data itself.
 * @public
 */
export interface InitialCoverage {
  readonly path: string
  readonly hash: string
  readonly gcv: string
  readonly coverageData: IstanbulFileCoverageData
}

/**
 * The initial coverage in `code` (code the Istanbul instrumenter wrote), or `null` when it holds
 * none, as `istanbul-lib-instrument`'s `readInitialCoverage`.
 * @public
 */
export function readInitialCoverage(code: string): InitialCoverage | null {
  const found = read(code)
  return found === null ? null : (found as unknown as InitialCoverage)
}
