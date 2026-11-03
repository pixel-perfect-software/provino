// The Jest dialect's `expect` slice (T7.5). The `Dialect` value that carries it is T1.8's (B14),
// and every value here is checked against Jest 30.5.2 by T1.7 then.
import { moduleRef } from '@provino/policy'
import type { ExpectPolicy, MatcherTableFactory } from '@provino/types'

/**
 * Jest 30.5's `expect` policy.
 * @public
 */
export const jestExpectPolicy: ExpectPolicy = {
  // unverified: track-01 L221
  matcherNamespace: 'jest',
  // unverified: track-01 L222 (Jest has no `expect.poll`; any value, with `poll.enabled` off)
  pollFailsOnTimeout: true,
  // unverified: track-01 L223
  diffContextLines: 5,
  // unverified: track-01 L223
  valueFormatter: 'pretty-format',
  // unverified: track-07 L460 (36 matchers, no aliases; B08 has the 32 that aren't snapshots)
  // Resolved here, so the worker's loader finds it from any package (a bare specifier would
  // resolve from @provino/policy).
  matcherTable: moduleRef<MatcherTableFactory>(
    import.meta.resolve('@provino/dialect-jest/runtime'),
    'jestExpectTable',
  ),
  // unverified: track-07 L461
  errorShape: 'matcher-result',
  // unverified: track-07 L463, L464
  equality: { errors: 'message', invalidDate: 'unequal' },
  // unverified: track-07 L465
  soft: false,
  // unverified: track-07 L465 (off; the interval and timeout are unused)
  poll: { enabled: false, intervalMs: 50, timeoutMs: 1000 },
  // unverified: track-07 L466
  requireAssertions: false,
  // unverified: track-07 L467 (`--expand` defaults to false)
  expand: false,
}
