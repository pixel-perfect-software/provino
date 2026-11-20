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
import { isChaiAssertionError } from './expect/chai.ts'
import { vitestMessages } from './expect/messages.ts'
import { customMatchers } from './vendor/vitest-expect/expect/custom-matchers.ts'
import {
  createCustomAsymmetric,
  JestExtendError,
  jestUtils,
} from './vendor/vitest-expect/expect/jest-extend.ts'

/** What a matcher's `this` holds that the wrapper reads. */
interface CallContext {
  readonly isNot: boolean
  readonly promise?: string
  readonly customMessage?: string
}

/** A failed Vitest assertion as a matcher result: the error rides along, for `assertionError`. */
interface FailedResult extends MatcherResult {
  readonly error: Error
}

/** Names `def` registers that are Vitest's plumbing, not matchers. */
const NOT_MATCHERS = new Set(['withTest', 'withContext'])

/**
 * One of Vitest's methods as a matcher: run on a fresh `VitestAssertion` with the call's flags. It
 * passes when the method returns, and a Chai `AssertionError` is its failure, handed back as the
 * result so the engine counts it, holds it under `expect.soft` and throws it where it belongs.
 */
function asMatcher(method: (this: VitestAssertion, ...args: unknown[]) => unknown): Matcher {
  return function vitestMatcher(this: CallContext, received: unknown, ...args: unknown[]) {
    const flags: Record<string, unknown> = Object.create(null)
    flags.object = received
    if (this.isNot) flags.negate = true
    if (this.promise) flags.promise = this.promise
    if (this.customMessage !== undefined) flags.message = this.customMessage
    const { isNot } = this
    try {
      method.apply(new VitestAssertion(flags), args)
    } catch (error) {
      if (!isChaiAssertionError(error)) throw error
      const failed: FailedResult = { pass: isNot, message: () => error.message, error }
      return failed
    }
    return { pass: !isNot, message: () => '' }
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
    messageArgument: true,
    // D170: Chai loads when a Chai property is first read.
    chain: (actual, name, call) => chaiChain(actual, name, call),
    customAsymmetric: (name, matcher) => createCustomAsymmetric(name, matcher as never),
    assertionError(result: MatcherResult, message: string, call: MatcherCall): Error {
      const own = (result as Partial<FailedResult>).error
      if (own instanceof Error) return withDiff(own)
      // `jest-extend.ts` L106-L113: a custom matcher's failure.
      const text = call.message === undefined ? message : `${call.message}: ${message}`
      return withDiff(new JestExtendError(text, result.actual, result.expected))
    },
  }
}
