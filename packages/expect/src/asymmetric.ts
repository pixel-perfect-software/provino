// The asymmetric-matcher base (T7.4, Track 7 R1). Jest's protocol exactly: `$$typeof`, a
// `sample`, an `inverse` flag, and a matcher context built from the realm's slot. Both runners
// detect asymmetric matchers by duck typing (F3), so a subclass works inside Jest's and Vitest's
// `expect` as well as ours. The dialects' built-ins (`any`, `objectContaining`, …) extend it.
import { equals } from '@jest/expect-utils'
import type { AsymmetricMatcherLike, EqualityTester, MatcherState } from '@provino/types'
import type { MatcherContext } from './context.ts'
import { freshCounters } from './internal/counters.ts'
import { readSlot } from './internal/slot-read.ts'

/**
 * The base every asymmetric matcher extends.
 * @public
 */
export abstract class AsymmetricMatcher<T> implements AsymmetricMatcherLike {
  readonly $$typeof: symbol = Symbol.for('jest.asymmetricMatcher')
  protected readonly sample: T
  protected readonly inverse: boolean

  constructor(sample: T, inverse = false) {
    this.sample = sample
    this.inverse = inverse
  }

  /**
   * A matcher context like the one a matcher gets (Jest's `getMatcherContext`): the current
   * state, the realm's equality testers and `utils`, and `isNot` from `inverse`. It reads the
   * slot, so it works under whichever engine installed it.
   */
  protected getMatcherContext(): MatcherContext {
    const slot = readSlot()
    return {
      customTesters: slot.customEqualityTesters ?? [],
      dontThrow: () => {},
      ...(slot.state ?? EMPTY_STATE),
      equals,
      isNot: this.inverse,
      utils: slot.utils ?? {},
    }
  }

  abstract asymmetricMatch(other: unknown, customTesters?: readonly EqualityTester[]): boolean
  abstract toString(): string
  getExpectedType?(): string
  toAsymmetricMatcher?(): string
}

/** The state outside any engine: no slot in this realm. */
const EMPTY_STATE: Readonly<MatcherState> = freshCounters()
