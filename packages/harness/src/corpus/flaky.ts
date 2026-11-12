// T12.10's flaky list: a test is flaky when its status is not the same in every reference run of its
// subject (Track 12 R1). A test one run has and another lacks counts, because "missing" is a
// different outcome from any status.
import type { NormalizedRun } from '@provino/types'
import { compareStrings } from '../internal/guards.ts'
import { testKey } from '../normalize.ts'

const ABSENT = 'absent'

/**
 * The keys (`file::a › b#0`) of the tests whose status differs between any two of `runs`, sorted
 * in code-point order. With fewer than two runs nothing can differ.
 * @public
 */
export function flakyKeys(runs: readonly NormalizedRun[]): string[] {
  const statuses = new Map<string, string[]>()
  runs.forEach((run, index) => {
    for (const file of run.files) {
      for (const test of file.tests) {
        const key = testKey(test.id)
        let seen = statuses.get(key)
        if (seen === undefined) {
          seen = Array.from({ length: runs.length }, () => ABSENT)
          statuses.set(key, seen)
        }
        seen[index] = test.status
      }
    }
  })
  return [...statuses]
    .filter(([, seen]) => new Set(seen).size > 1)
    .map(([key]) => key)
    .toSorted(compareStrings)
}
