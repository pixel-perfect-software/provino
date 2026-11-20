// The Vitest dialect's matcher table (T7.6, D170): what `vitestPolicy.expect.matcherTable` loads.
// The matchers are `@vitest/expect` 5.0.5's own jest-style methods (`vendor/vitest-expect/`, see
// its UPSTREAM.md), each run on a `VitestAssertion` (`expect/assertion.ts`) rather than a Chai
// `Assertion`: `@provino/expect`'s lazy front end calls the one matcher used, and Chai loads only
// when an assertion fails or one of the four matchers that are Chai's own runs. A failure is
// Chai's `AssertionError`, with `actual`, `expected` and the `diff` Vitest's runner would add; a
// custom matcher's is Vitest's `JestExtendError`. Aliases (`toBeCalled`, `toThrowError`, …) are
// all here, as Vitest keeps them.
import { snapshotMatchers } from '@provino/expect'
import type { ExpectTable, Matcher, MatcherCall, MatcherResult, MatcherSet } from '@provino/types'
import { printDiffOrStringify } from '../vendor/vitest-utils/diff/index.ts'
import { chaiChain, loadVitestPlugins, VitestAssertion } from './expect/assertion.ts'
import { chai } from './expect/chai.ts'
import { vitestMessages } from './expect/messages.ts'
import { customMatchers } from './vendor/vitest-expect/expect/custom-matchers.ts'
import {
  createCustomAsymmetric,
  JestExtendError,
  jestUtils,
} from './vendor/vitest-expect/expect/jest-extend.ts'
import { equals as vitestEquals } from './vendor/vitest-expect/expect/jest-utils.ts'

/** What a matcher's `this` holds that the wrapper reads. */
interface CallContext {
  readonly isNot: boolean
  readonly promise?: string
  readonly customMessage?: string
}

/** Names `def` registers that are Vitest's plumbing, not matchers. */
const NOT_MATCHERS = new Set(['withTest', 'withContext'])

/**
 * One of Vitest's methods as a matcher: run on a fresh `VitestAssertion` with the call's flags. It
 * passes when the method returns; what it throws (a Chai `AssertionError` for a failure) goes on to
 * the engine, which anchors it at the user's call and holds it under `expect.soft`, as Vitest's
 * `wrapAssertion` does.
 */
function asMatcher(method: (this: VitestAssertion, ...args: unknown[]) => unknown): Matcher {
  return function vitestMatcher(this: CallContext, received: unknown, ...args: unknown[]) {
    const flags: Record<string, unknown> = { object: received }
    if (this.isNot) flags.negate = true
    if (this.promise) flags.promise = this.promise
    if (this.customMessage !== undefined) flags.message = this.customMessage
    method.apply(new VitestAssertion(flags), args)
    return { pass: !this.isNot, message: () => '' }
  } as unknown as Matcher
}

/**
 * The `diff` Vitest's runner gives a failure (`@vitest/utils`' `processError`, `error.ts` L18-L28),
 * on the error itself. The table's own failures carry it when thrown; an error thrown past the
 * table (a Chai chain's, a test's own) gets it where the run reports it.
 * @internal
 */
export function withDiff(error: Error): Error {
  const shaped = error as Error & {
    showDiff?: boolean
    actual?: unknown
    expected?: unknown
    diff?: string | undefined
  }
  if (typeof shaped.diff === 'string') return error
  if (
    shaped.showDiff ||
    (shaped.showDiff === undefined && shaped.expected !== undefined && shaped.actual !== undefined)
  ) {
    shaped.diff = printDiffOrStringify(shaped.actual, shaped.expected, {})
  }
  return error
}

/**
 * Builds the Vitest 5.0 matcher table. The worker loads it once, by `ModuleRef`, after the slot is
 * installed (the matchers read its equality testers when the plugins run).
 * @public
 */
export function vitestExpectTable(): ExpectTable {
  const plugins = loadVitestPlugins()
  const matchers: Record<string, Matcher> = {}
  for (const [name, method] of plugins.methods) {
    if (!NOT_MATCHERS.has(name)) matchers[name] = asMatcher(method)
  }
  const snapshot = snapshotMatchers({ fileSnapshot: true })
  // Vitest `expect.extend`s these two, so each has its asymmetric form on `expect` and `expect.not`.
  const asymmetric: Record<string, unknown> = { ...plugins.asymmetric }
  const asymmetricNot: Record<string, unknown> = { ...plugins.asymmetricNot }
  for (const [name, matcher] of Object.entries(customMatchers)) {
    const build = createCustomAsymmetric(name, matcher)
    asymmetric[name] = (...sample: unknown[]) => build(false, sample)
    asymmetricNot[name] = (...sample: unknown[]) => build(true, sample)
  }
  return {
    // `toSatisfy` and `toBeOneOf` are `expect.extend`ed in Vitest (`integrations/chai/index.ts`
    // L95); here they are built-ins with the rest.
    matchers: { ...matchers, ...(customMatchers as unknown as MatcherSet), ...snapshot.matchers },
    promiseMatchers: { ...snapshot.promiseMatchers },
    asymmetric: asymmetric as ExpectTable['asymmetric'],
    asymmetricNot: asymmetricNot as ExpectTable['asymmetricNot'],
    utils: jestUtils(),
    messages: vitestMessages,
    // D170: Chai loads when a Chai property is first read. A matcher that passed returns its
    // assertion, as in Vitest (`expect(1).toBe(1).to.equal(1)`), which loads Chai only when a chain
    // is read from it.
    chain: chaiChain,
    // A custom matcher's `this.equals` is Vitest's (`jest-extend.ts` L42), not Jest's.
    equals: vitestEquals,
    customAsymmetric: (name, matcher) => createCustomAsymmetric(name, matcher as never),
    // A wrong settlement's error and a custom matcher's: the table's own matchers throw theirs.
    // `vitestShapeTestError` gives each its `diff` where the run reports it.
    assertionError(result: MatcherResult, message: string, call: MatcherCall): Error {
      // `jest-expect.ts` L1063-L1070 and L1003-L1008: a wrong settlement is Chai's `AssertionError`,
      // with a diff against a rejected promise's error, or none and the reason as its `cause`.
      if (call.settlement === 'resolved') {
        const { AssertionError } = chai()
        return new AssertionError(message, {
          showDiff: true,
          expected: new Error('rejected promise'),
          actual: result.actual,
        })
      }
      if (call.settlement === 'rejected') {
        const error = new (chai().AssertionError)(message, { showDiff: false })
        return Object.assign(error, { cause: result.actual })
      }
      // `jest-extend.ts` L106-L113: a custom matcher's failure.
      const text = call.message === undefined ? message : `${call.message}: ${message}`
      return new JestExtendError(text, result.actual, result.expected)
    },
  }
}

/**
 * The Vitest dialect's `core.shapeTestError`: each error a failed test ended with gets the `diff`
 * Vitest's runner gives it (`withDiff`) when it has none yet, which an error thrown past the table
 * (a Chai chain's, a test's own `AssertionError`-shaped value) needs; core keeps it as the
 * serialized error's `diff`. Anything that isn't an `Error` is reported as thrown.
 * @public
 */
export function vitestShapeTestError(error: unknown): unknown {
  return error instanceof Error ? withDiff(error) : error
}
