// provino: an extract of `packages/expect/src/jest-extend.ts`: `JestExtendError` (L61-L73), the
// `this.utils` a custom matcher gets (`getMatcherState` L23-L29) and the `CustomMatcher` class
// `JestExtendPlugin` makes per registration (L131-L160), as a builder. `@provino/expect` runs
// `expect.extend` itself, so the Chai plugin, `use` and the slot writes are left out.
import type { Tester } from './types.ts'
import { AsymmetricMatcher } from './jest-asymmetric-matchers.ts'
import { diff, getMatcherUtils, stringify } from './jest-matcher-utils.ts'
import { iterableEquality, subsetEquality } from './jest-utils.ts'

interface VitestErrorContext {
  assertionName: string
  meta?: object
}

export class JestExtendError extends Error {
  // provino: fields and assignments in place of parameter properties, which Node's type stripping
  // can't run
  actual?: any
  expected?: any
  /** @internal */
  __vitest_error_context__?: VitestErrorContext

  constructor(
    message: string,
    actual?: any,
    expected?: any,
    /** @internal */
    __vitest_error_context__?: VitestErrorContext,
  ) {
    super(message)
    this.actual = actual
    this.expected = expected
    this.__vitest_error_context__ = __vitest_error_context__
  }
}

/** What `getMatcherState` gives a custom matcher as `this.utils`. */
export function jestUtils(): Record<string, unknown> {
  return {
    ...getMatcherUtils(),
    diff,
    stringify,
    iterableEquality,
    subsetEquality,
  }
}

type RawMatcher = (this: any, actual: unknown, ...expected: unknown[]) => any

/** `JestExtendPlugin`'s `CustomMatcher`, one class per registration. */
export function createCustomAsymmetric(
  expectAssertionName: string,
  expectAssertion: RawMatcher,
): (inverse: boolean, sample: readonly unknown[]) => AsymmetricMatcher<[unknown, ...unknown[]]> {
  class CustomMatcher extends AsymmetricMatcher<[unknown, ...unknown[]]> {
    constructor(inverse = false, ...sample: [unknown, ...unknown[]]) {
      super(sample, inverse)
    }

    asymmetricMatch(other: unknown, customTesters?: Array<Tester>) {
      const context = this.getMatcherContext()
      const { pass } = expectAssertion.call(
        customTesters ? { ...context, customTesters } : context,
        other,
        ...this.sample,
      )

      return this.inverse ? !pass : pass
    }

    toString() {
      return `${this.inverse ? 'not.' : ''}${expectAssertionName}`
    }

    getExpectedType() {
      return 'any'
    }

    toAsymmetricMatcher() {
      return `${this.toString()}<${this.sample.map((item) => stringify(item)).join(', ')}>`
    }
  }
  return (inverse, sample) => new CustomMatcher(inverse, ...(sample as [unknown, ...unknown[]]))
}
