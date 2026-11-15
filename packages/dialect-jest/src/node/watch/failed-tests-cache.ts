// jest-core `FailedTestsCache.ts` L12-L51: what `--onlyFailures` keeps in watch mode, from the
// previous run's results (not the results cache a run without watch reads).
import type { JestWatchResults } from './hooks.ts'

/**
 * The failed tests of the last run, by file.
 * @beta
 */
export class JestFailedTestsCache {
  #enabled: Readonly<Record<string, Readonly<Record<string, true>>>> | undefined

  /**
   * `filterTests` (L15-L22): before any run, every path; after one, the files that failed in it (a
   * file that failed to run counts, with no test named).
   */
  filterPaths<T extends { readonly path: string }>(tests: readonly T[]): readonly T[] {
    const enabled = this.#enabled
    if (enabled === undefined) return tests
    return tests.filter((test) => Object.hasOwn(enabled, test.path))
  }

  /** `setTestResults` (L24-L50). */
  setTestResults(testResults: JestWatchResults['testResults']): void {
    const map: Record<string, Readonly<Record<string, true>>> = {}
    for (const result of testResults) {
      if (result.testExecError !== undefined && result.testExecError !== null) {
        map[result.testFilePath] = {}
        continue
      }
      if (!result.numFailingTests) continue
      const names: Record<string, true> = {}
      for (const test of result.testResults) {
        if (test.status === 'failed') names[test.fullName] = true
      }
      map[result.testFilePath] = names
    }
    this.#enabled = Object.freeze(map)
  }
}
