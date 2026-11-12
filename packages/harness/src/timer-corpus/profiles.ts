// The `timers` policy slice for each recording profile, used to run the timer corpus (T4.9)
// through `@provino/timers` (B17a). Each profile is a dialect's own, so this corpus checks the
// dialects' values.
import { jestPolicy } from '@provino/dialect-jest'
import { vitestPolicy } from '@provino/dialect-vitest'
import { resolvePolicy } from '@provino/policy'
import type { TimersPolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

/** The `timers` policy a recording profile stands for. */
export const timersPolicyFor: Readonly<Record<FixtureProfile, TimersPolicy>> = {
  jest: resolvePolicy(jestPolicy).timers,
  vitest: resolvePolicy(vitestPolicy).timers,
  'vitest-list': resolvePolicy(vitestPolicy).timers,
}
