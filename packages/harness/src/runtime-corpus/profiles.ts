// The `core` policy slice for each recording profile, used to run the runtime corpus (T5.2) through
// `@provino/core` (B07). Each profile is a dialect's own: Jest's from `@provino/dialect-jest`,
// Vitest's from `@provino/dialect-vitest` (B14a moved its values there), so this corpus checks the
// dialects' values. `vitest-list` is a Vitest project config, not a dialect: `sequence.hooks:
// 'list'` puts after-hooks in declaration order, which the corpus recorded.
import { jestPolicy } from '@provino/dialect-jest'
import { vitestPolicy } from '@provino/dialect-vitest'
import { resolvePolicy } from '@provino/policy'
import type { CorePolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

/** Vitest's `sequence.hooks: 'list'`, as a project layer over the Vitest dialect. */
const VITEST_LIST_HOOKS = {
  core: {
    hookOrder: {
      beforeAll: 'declaration',
      beforeEach: 'declaration',
      afterEach: 'declaration',
      afterAll: 'declaration',
    },
  },
} as const

/** The `core` policy a recording profile stands for. */
export const corePolicyFor: Readonly<Record<FixtureProfile, CorePolicy>> = {
  jest: resolvePolicy(jestPolicy).core,
  vitest: resolvePolicy(vitestPolicy).core,
  'vitest-list': resolvePolicy(vitestPolicy, VITEST_LIST_HOOKS).core,
}
