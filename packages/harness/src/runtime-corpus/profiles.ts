// The `core` policy slice for each recording profile, used to run the runtime corpus (T5.2) through
// `@provino/core` (B07). The Jest profile is the Jest dialect's own (B10 moved the values there, so
// this corpus checks the dialect's). The Vitest profiles stand in for `@provino/dialect-vitest`
// until B14 (T1.8) builds it; the corpus goldens back the values they exercise, and T1.7 verifies
// every one, so each stays marked unverified (CLAUDE.md non-negotiable 2).
import { jestPolicy } from '@provino/dialect-jest'
import { neutralPolicy, resolvePolicy } from '@provino/policy'
import type { CorePolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

const neutral = neutralPolicy.core

/**
 * Jest 30.5's `core` values, read from the Jest dialect: its `unverified` claims, "runtime corpus X
 * agrees" among them, live there, and this check is what keeps them true.
 */
const jest: CorePolicy = resolvePolicy(jestPolicy).core

/** Vitest 5.0's `core` values with `sequence.hooks: 'stack'` (its default). */
const vitestStack: CorePolicy = {
  ...neutral,
  // unverified: track-05 L313 (runtime corpus `hook-order` agrees)
  hookOrder: {
    beforeAll: 'declaration',
    beforeEach: 'declaration',
    afterEach: 'reverse',
    afterAll: 'reverse',
  },
  // unverified: track-05 L315
  eachHooksForConcurrent: true,
  // unverified: track-05 L316
  firstArg: 'context',
  // unverified: track-01 L183
  allowGeneratorFns: false,
  // unverified: track-05 L315, L318 (runtime corpus `timeouts` agrees on catchSyncOverrun)
  timeouts: { test: 5000, hook: 10000, teardown: 10000, catchSyncOverrun: true, zero: 'none' },
  // unverified: track-05 L321
  nameSeparator: ' > ',
  // unverified: track-01 L186
  testNamePatternFlags: '',
  // unverified: track-05 L312 (runtime corpus `collection-missing-fn` agrees)
  missingTestFn: 'todo',
  // unverified: track-05 L311 (runtime corpus `collection-async-describe` agrees)
  asyncDescribe: 'await',
  // unverified: track-01 L189
  nonPromiseReturn: 'ignore',
  // unverified: track-05 L319
  retry: { timing: 'immediate', logErrorsBeforeRetry: true, keepEarlierErrors: true },
  // unverified: track-01 L193 (runtime corpus `only-scope` agrees under CI)
  allowOnly: 'not-in-ci',
  // unverified: track-05 L317 (runtime corpus `concurrent-limit` agrees)
  maxConcurrency: 5,
  // unverified: track-07 L462
  unawaitedAsyncAssertion: 'fail',
  // unverified: track-05 L314 (runtime corpus `hook-teardowns` agrees)
  hookReturnsCleanup: true,
  // unverified: track-11 L521
  injectGlobals: false,
  collect: {
    // unverified: track-05 L311 (runtime corpus `describe-body` agrees)
    describeBody: 'deferred',
    // unverified: track-05 Findings L46 (runtime corpus `collection-describe-return-value` agrees)
    describeReturnValue: 'ignore',
    // unverified: track-05 L312 (runtime corpus `collection-test-after-start` agrees)
    lateRegistration: 'warn-drop',
    // unverified: track-05 L312 (runtime corpus `collection-describe-empty` agrees)
    emptyDescribe: 'fail-suite',
    // unverified: track-05 L47 (runtime corpus `collection-nested-test` agrees)
    nestedInTest: 'throw',
    // unverified: track-05 L57 (runtime corpus `collection-todo-with-fn` agrees)
    todoWithFn: 'todo',
    // unverified: Vitest 5.0 drops an incomplete trailing row (B07 review)
    eachTableError: 'lenient',
  },
  hooks: {
    // unverified: track-05 L314 (runtime corpus `hook-failures` agrees)
    afterError: 'abort-chain',
    // unverified: track-05 L314 (runtime corpus `hook-failures-before-all` agrees)
    beforeAllError: 'skip-subtree',
    // unverified: track-12 L528
    nestedHooksAfterBeforeAllError: 'skip',
    // unverified: track-05 L314 (runtime corpus `hook-failures-after-all` agrees)
    afterAllError: 'fail-suite',
    // unverified: not in the research; Vitest gives hooks their own timeout
    timeoutCountsTestTimeout: false,
    // unverified: track-12 L528
    skippedBlock: 'none',
  },
  concurrency: {
    // unverified: track-05 L317 (runtime corpus `concurrent-grouping` agrees)
    grouping: 'consecutive',
    // unverified: track-05 L317
    limitHooks: true,
  },
  // unverified: track-05 L320
  errors: { lateErrors: 'report-run', hasAssertionsWhenFailed: 'check' },
  // unverified: track-12 L528
  focus: { scope: 'suite', insideSkip: 'skipped' },
  // unverified: track-12 L528; expectFail from Vitest 5.0 `runTest` (B07 review)
  status: { todoUnderSkip: 'todo', expectFail: 'attempt' },
  // unverified: Vitest 5.0 `findTestFileStackTrace` (B07 review)
  locationFrame: 'test-file',
  // unverified: track-01 L191
  eachTitleTruncate: 40,
}

/** Vitest 5.0 with `sequence.hooks: 'list'`: after-hooks in declaration order. */
const vitestList: CorePolicy = {
  ...vitestStack,
  // unverified: track-05 L313 (runtime corpus `hook-order` agrees)
  hookOrder: {
    beforeAll: 'declaration',
    beforeEach: 'declaration',
    afterEach: 'declaration',
    afterAll: 'declaration',
  },
}

/** The `core` policy a recording profile stands for. */
export const corePolicyFor: Readonly<Record<FixtureProfile, CorePolicy>> = {
  jest,
  vitest: vitestStack,
  'vitest-list': vitestList,
}
