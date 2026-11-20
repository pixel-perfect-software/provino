import type { ExpectTable } from '../expect.ts'
import type { Behaviour } from './behaviour.ts'

/**
 * Returns the matcher table a dialect's `expect` exposes (`@provino/expect` loads it once per
 * worker).
 * @public
 */
export type MatcherTableFactory = () => ExpectTable

/**
 * The `expect` slice, read by `@provino/expect` (Track 7).
 * @public
 */
export interface ExpectPolicy {
  /** The namespace in matcher messages and the global matcher slot. Jest: `'jest'`. Vitest: `'vitest'`. research: track-01 L221 */
  readonly matcherNamespace: string
  /**
   * Where the assertion counters made outside any test go (module scope, `beforeAll`, an
   * `afterAll` after a test's end). `drop`: they count for no test. `next-test`: they go to the
   * next test to end (under concurrency, to the first attempt that asserts or ends with none
   * having asserted: Jest shares one state, and this is the declared improvement), and what is left
   * after the file's last test is dropped.
   * Jest: `next-test` (`fixtures/expect/policies/assertions-outside-test`; jest-circus resets the
   * counters only at `test_done`, `jestAdapterInit.ts` L362-367). Vitest: `drop`, pending T11.16.
   * Neutral: `drop`, Provino's own.
   */
  readonly outsideTestCounts: 'drop' | 'next-test'
  /**
   * What counts as an assertion call (`expect.assertions(n)`, `expect.hasAssertions()`).
   * `per-matcher-call`: each matcher call that returns a result (Jest's `makeThrowingMatcher`).
   * `per-expect-call`: each `expect()`, `expect.soft()` and `expect.poll()` call, whatever runs on
   * it: a bare `expect(x)` counts, one `expect(x)` reused for two matchers counts once (Vitest's
   * `createExpect`, `integrations/chai/index.ts` L18-L20). Jest and neutral: `per-matcher-call`.
   * Vitest: `per-expect-call` (`fixtures/expect/policies/assertions-per-expect`).
   */
  readonly assertionCalls: 'per-matcher-call' | 'per-expect-call'
  /** Whether `expect.poll` fails on timeout. Jest: no `expect.poll` (any value; `poll.enabled` is off). Vitest: `true`. research: track-01 L222 */
  readonly pollFailsOnTimeout: boolean
  /** Lines of context in diffs. Jest: 5. Vitest: 5. research: track-01 L223 */
  readonly diffContextLines: number
  /** How values are printed in messages. Jest: `pretty-format`. Vitest: `pretty-format`. research: track-01 L223 */
  readonly valueFormatter: 'pretty-format'
  /**
   * The matcher table, or `null` for `@provino/expect`'s neutral table.
   * Jest: 36 matchers, no aliases. Vitest: 56 Jest-style plus 30 Chai/sinon names. research: track-07 L460
   */
  readonly matcherTable: Behaviour<MatcherTableFactory> | null
  /**
   * The error a failed assertion throws: an `Error` with `matcherResult` and the text in `message`
   * (`matcher-result`), or an `AssertionError` with `diff`/`expected`/`actual` (`assertion-error`).
   * Track 7 names the values `'jest' | 'vitest'`; renamed so neutral code never compares a runner
   * name. Jest: `matcher-result`. Vitest: `assertion-error`. research: track-07 L461
   */
  readonly errorShape: 'matcher-result' | 'assertion-error'
  /**
   * When `.resolves`/`.rejects` checks its value. `at-call`: when the matcher is called (Jest's
   * `makeRejectMatcher`: `expect(5).resolves.toBe(5)` fails at `.toBe`, a matcher error).
   * `at-read`: when `.resolves`/`.rejects` is read (Vitest's `jest-expect.ts` L979-L983: a
   * `TypeError` there, `.rejects` of a function calls it then, and a settled failure reports the
   * read's stack). Jest: `at-call`. Vitest: `at-read` (`fixtures/expect/messages/promises`, the
   * non-promise cases' column). Neutral: `at-read`.
   */
  readonly settlementCheck: 'at-call' | 'at-read'
  /**
   * Whether `expect(actual, message)` takes a message after the value, which the table words a
   * failure with. `false`: a second argument is `messages.tooManyArguments`. Jest: `false`.
   * Vitest: `true` (`fixtures/expect/messages/extend-and-misuse`). Neutral: `false`.
   */
  readonly messageArgument: boolean
  /** Equality edge cases (Track 7 `expect.equality.*`). */
  readonly equality: {
    /** How `toEqual` compares `Error`s. Jest: `message`. Vitest: `assert`. research: track-07 L463 */
    readonly errors: 'message' | 'assert'
    /** Whether two invalid `Date`s are equal. Jest: `unequal`. Vitest: `equal`. research: track-07 L464 */
    readonly invalidDate: 'unequal' | 'equal'
  }
  /** Whether `expect.soft` exists. Jest: `false`. Vitest: `true`. research: track-07 L465 */
  readonly soft: boolean
  /**
   * `expect.poll`: whether it exists, and its defaults. Track 7's `{ interval, timeout } | false`,
   * as one object so a layer can override a single field.
   * Jest: off. Vitest: on, 50 ms / 1000 ms. research: track-07 L465
   */
  readonly poll: {
    readonly enabled: boolean
    readonly intervalMs: number
    readonly timeoutMs: number
  }
  /** Whether every test must make an assertion. Jest: `false`. Vitest: config `expect.requireAssertions`. research: track-07 L466 */
  readonly requireAssertions: boolean
  /** Whether diffs are expanded. Jest: `--expand` (default `false`). Vitest: `expandSnapshotDiff`. research: track-07 L467 */
  readonly expand: boolean
}
