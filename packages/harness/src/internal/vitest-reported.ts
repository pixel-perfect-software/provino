// What the Vitest reporters the recorder loads by absolute path (`reporters/vitest.ts`,
// `reporters/vitest-diff.ts`) read of a reported test. Node builtins and `./keys.ts` only: they
// can't resolve a package from a project's config (`reporters/imports.test.ts`).
import type { TestCase } from 'vitest/node'
import { pathText } from './keys.ts'

/** A test's title path: its suites' names from the outside in, then its own. */
export function titlePath(test: TestCase): string[] {
  const path = [test.name]
  for (let parent = test.parent; parent.type === 'suite'; parent = parent.parent) {
    path.unshift(parent.name)
  }
  return path
}

/**
 * A test's index among the tests of its module with the same title path, in declaration order:
 * the converters' own key, so a reporter and the converter count alike by construction. Each
 * module is counted once, the first time one of its tests is asked about.
 */
export function dupIndexer(): (test: TestCase) => number {
  const dupIndex = new Map<string, number>()
  return (test) => {
    if (!dupIndex.has(test.id)) {
      const seen = new Map<string, number>()
      for (const each of test.module.children.allTests()) {
        const key = pathText(titlePath(each))
        const index = seen.get(key) ?? 0
        seen.set(key, index + 1)
        dupIndex.set(each.id, index)
      }
    }
    return dupIndex.get(test.id) ?? 0
  }
}
