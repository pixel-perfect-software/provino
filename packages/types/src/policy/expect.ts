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
  /** The namespace in matcher messages and the global matcher slot. Jest: `'jest'`. Vitest: `'vitest'`. unverified: track-01 L221 */
  readonly matcherNamespace: string
  /** Whether `expect.poll` fails on timeout. Jest: no `expect.poll` (any value; `poll.enabled` is off). Vitest: `true`. unverified: track-01 L222 */
  readonly pollFailsOnTimeout: boolean
  /** Lines of context in diffs. Jest: 5. Vitest: 5. unverified: track-01 L223 */
  readonly diffContextLines: number
  /** How values are printed in messages. Jest: `pretty-format`. Vitest: `pretty-format`. unverified: track-01 L223 */
  readonly valueFormatter: 'pretty-format'
  /**
   * The matcher table, or `null` for `@provino/expect`'s neutral table.
   * Jest: 36 matchers, no aliases. Vitest: 56 Jest-style plus 30 Chai/sinon names. unverified: track-07 L460
   */
  readonly matcherTable: Behaviour<MatcherTableFactory> | null
  /**
   * The error a failed assertion throws: an `Error` with `matcherResult` and the text in `message`
   * (`matcher-result`), or an `AssertionError` with `diff`/`expected`/`actual` (`assertion-error`).
   * Track 7 names the values `'jest' | 'vitest'`; renamed so neutral code never compares a runner
   * name. Jest: `matcher-result`. Vitest: `assertion-error`. unverified: track-07 L461
   */
  readonly errorShape: 'matcher-result' | 'assertion-error'
  /** Equality edge cases (Track 7 `expect.equality.*`). */
  readonly equality: {
    /** How `toEqual` compares `Error`s. Jest: `message`. Vitest: `assert`. unverified: track-07 L463 */
    readonly errors: 'message' | 'assert'
    /** Whether two invalid `Date`s are equal. Jest: `unequal`. Vitest: `equal`. unverified: track-07 L464 */
    readonly invalidDate: 'unequal' | 'equal'
  }
  /** Whether `expect.soft` exists. Jest: `false`. Vitest: `true`. unverified: track-07 L465 */
  readonly soft: boolean
  /**
   * `expect.poll`: whether it exists, and its defaults. Track 7's `{ interval, timeout } | false`,
   * as one object so a layer can override a single field.
   * Jest: off. Vitest: on, 50 ms / 1000 ms. unverified: track-07 L465
   */
  readonly poll: {
    readonly enabled: boolean
    readonly intervalMs: number
    readonly timeoutMs: number
  }
  /** Whether every test must make an assertion. Jest: `false`. Vitest: config `expect.requireAssertions`. unverified: track-07 L466 */
  readonly requireAssertions: boolean
  /** Whether diffs are expanded. Jest: `--expand` (default `false`). Vitest: `expandSnapshotDiff`. unverified: track-07 L467 */
  readonly expand: boolean
}
