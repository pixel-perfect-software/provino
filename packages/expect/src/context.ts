// What a matcher's `this` is (Jest's `MatcherContext`: `MatcherUtils & Readonly<MatcherState>`).

import type { EqualityTester, MatcherState, PromiseVoice } from '@provino/types'
import type { equals } from './vendor/expect-utils/index.ts'

/**
 * A matcher's `this`: the current state (copied, as Jest spreads it), equality, the dialect's
 * `utils`, and how the call was made.
 * @public
 */
export interface MatcherContext extends Readonly<MatcherState> {
  readonly isNot: boolean
  /** Absent in an asymmetric matcher's context, as in Jest. */
  readonly promise?: PromiseVoice
  readonly equals: typeof equals
  readonly customTesters: readonly EqualityTester[]
  /** The dialect's helpers (Jest: `jest-matcher-utils` plus `iterableEquality`/`subsetEquality`). */
  readonly utils: object
  /** The error the failure will reuse, under `.resolves`/`.rejects`. */
  readonly error?: Error | undefined
  /** `expect(actual, message)`'s message, where the dialect's table takes one. */
  readonly customMessage?: string
  /** Set when the call is `expect.soft`'s, as Vitest's matcher state has it. */
  readonly soft?: true
  /** Set when the call is a try of `expect.poll`, as Vitest's matcher state has it. */
  readonly poll?: true
  /** Records a failure instead of throwing it (snapshot matchers). */
  dontThrow(): void
}
