// The `mock` policy slice for each recording profile, used to run the mocking corpus (T4.1) through
// `@provino/mock` (B13a). Each profile is a dialect's own (B14a moved Vitest's values, with its
// `module` slice and hoisting rules, to `@provino/dialect-vitest`), so this corpus checks the
// dialects' values. They are re-exported here for the corpus checks and the bench, which imported
// them from the harness before.
import { jestMockPolicy } from '@provino/dialect-jest'
import { vitestHoistPolicy, vitestMockPolicy, vitestModulePolicy } from '@provino/dialect-vitest'
import type { MockPolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

export { vitestHoistPolicy, vitestMockPolicy, vitestModulePolicy }

/** The `mock` policy a recording profile stands for. */
export const mockPolicyFor: Readonly<Record<FixtureProfile, MockPolicy>> = {
  jest: jestMockPolicy,
  vitest: vitestMockPolicy,
  'vitest-list': vitestMockPolicy,
}
