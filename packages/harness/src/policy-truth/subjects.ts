// The two dialects T1.7 checks, as the corpora and the claims see them: the resolved policy, the
// loader's hoisting rules, the globals' names and the profile whose goldens stand for it.
import { jestDialect, jestHoistPolicy, jestPolicy } from '@provino/dialect-jest'
import { vitestDialect, vitestHoistPolicy, vitestPolicy } from '@provino/dialect-vitest'
import { resolvePolicy } from '@provino/policy'
import type { Dialect, HoistPolicy, Policy } from '@provino/types'
import type { FixtureRunner } from '../fixture.ts'
import { policyLeaves } from './leaves.ts'

/** A dialect under check. */
export interface DialectSubject {
  readonly runner: FixtureRunner
  readonly dialect: Dialect
  readonly policy: Policy
  readonly hoist: HoistPolicy
}

/** Jest 30.5 and Vitest 5.0, by runner. */
export const SUBJECTS: Readonly<Record<FixtureRunner, DialectSubject>> = {
  jest: {
    runner: 'jest',
    dialect: jestDialect,
    policy: resolvePolicy(jestPolicy),
    hoist: jestHoistPolicy,
  },
  vitest: {
    runner: 'vitest',
    dialect: vitestDialect,
    policy: resolvePolicy(vitestPolicy),
    hoist: vitestHoistPolicy,
  },
}

/**
 * Every leaf a dialect's value claims: the resolved policy's (keys left at the neutral value
 * included: leaving a key out says the neutral value is the runner's), the hoisting rules' under
 * `hoist.`, and the globals' names as `globals.names`.
 */
export function subjectLeaves(subject: DialectSubject): Map<string, unknown> {
  const leaves = policyLeaves(subject.policy)
  for (const [path, value] of policyLeaves(subject.hoist, 'hoist')) leaves.set(path, value)
  leaves.set('globals.names', subject.dialect.globals?.names ?? null)
  return leaves
}
