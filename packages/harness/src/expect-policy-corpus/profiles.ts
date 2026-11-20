// The two policy sets the policy corpus runs the fixtures under: each dialect's own `CorePolicy`
// and `ExpectPolicy`, from `@provino/dialect-jest` and `@provino/dialect-vitest`.
import { jestExpectPolicy } from '@provino/dialect-jest'
import { vitestPolicy } from '@provino/dialect-vitest'
import { resolvePolicy } from '@provino/policy'
import type { CorePolicy, ExpectPolicy } from '@provino/types'
import { corePolicyFor } from '../runtime-corpus/profiles.ts'
import type { PolicyRun } from './run-policy.ts'

/** The profiles the corpus has: a dialect each. */
export type PolicyProfile = 'jest' | 'vitest'

/** One wrong policy value, laid over a profile's policy: `core` and `expect` replace those keys. */
interface PolicyLayer {
  readonly core?: Partial<CorePolicy>
  readonly expect?: Partial<ExpectPolicy>
}

/** The name of a flip. */
export type PolicyFlip =
  | 'unawaited-ignore'
  | 'unawaited-fail'
  | 'soft-off'
  | 'poll-off'
  | 'poll-quiet-timeout'
  | 'counts-dropped'
  | 'calls-per-matcher'
  | 'calls-per-expect'

/** Wrong policy values, to show the corpus notices each. */
export const FLIPS: Readonly<Record<PolicyFlip, PolicyLayer>> = {
  /** Vitest's unawaited-assertion rule turned off. */
  'unawaited-ignore': { core: { unawaitedAsyncAssertion: 'ignore' } },
  /** Jest's turned on. */
  'unawaited-fail': { core: { unawaitedAsyncAssertion: 'fail' } },
  'soft-off': { expect: { soft: false } },
  'poll-off': { expect: { poll: { enabled: false, intervalMs: 50, timeoutMs: 1000 } } },
  'poll-quiet-timeout': { expect: { pollFailsOnTimeout: false } },
  /** Jest's `next-test` carry turned off: nothing counted outside a test reaches a test. */
  'counts-dropped': { expect: { outsideTestCounts: 'drop' } },
  /** Jest's count, one per matcher call that returns a result, under Vitest. */
  'calls-per-matcher': { expect: { assertionCalls: 'per-matcher-call' } },
  /** Vitest's count, one per `expect()` call, under Jest. */
  'calls-per-expect': { expect: { assertionCalls: 'per-expect-call' } },
}

/** The policy a profile runs under, with `flip` laid over it when there is one. */
export function policyFor(profile: PolicyProfile, flip?: PolicyFlip): PolicyRun {
  const base: PolicyRun =
    profile === 'jest'
      ? { core: corePolicyFor.jest, expect: jestExpectPolicy }
      : // Vitest's own slice, its matcher table included (T7.6).
        { core: corePolicyFor.vitest, expect: resolvePolicy(vitestPolicy).expect }
  if (flip === undefined) return base
  const layer = FLIPS[flip]
  return { core: { ...base.core, ...layer.core }, expect: { ...base.expect, ...layer.expect } }
}
