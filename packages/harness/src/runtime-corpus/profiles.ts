// The `core` policy slice for each recording profile, used to run the runtime corpus (T5.2) through
// `@provino/core` (B07). These stand in for the dialects' values until B14 (T1.8) builds
// `@provino/dialect-jest`/`-vitest`; the corpus goldens back the values they exercise, and T1.7
// verifies every one, so each stays marked unverified (CLAUDE.md non-negotiable 2).
import { neutralPolicy } from '@provino/policy'
import type { CorePolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

const neutral = neutralPolicy.core

/** Jest 30.5's `core` values. */
const jest: CorePolicy = {
  ...neutral,
  // unverified: track-05 L313 (runtime corpus `hook-order` agrees)
  hookOrder: {
    beforeAll: 'declaration',
    beforeEach: 'declaration',
    afterEach: 'declaration',
    afterAll: 'declaration',
  },
  // unverified: track-05 L315 (runtime corpus `concurrent-grouping` agrees)
  eachHooksForConcurrent: false,
  // unverified: track-05 L316
  firstArg: 'done-if-arity',
  // unverified: track-01 L183
  allowGeneratorFns: true,
  // unverified: track-05 L315, L318 (runtime corpus `timeouts` agrees on catchSyncOverrun)
  timeouts: { test: 5000, hook: 5000, teardown: 5000, catchSyncOverrun: false },
  // unverified: track-05 L321
  nameSeparator: ' ',
  // unverified: track-01 L186
  testNamePatternFlags: 'i',
  // unverified: track-05 L312 (runtime corpus `collection-missing-fn` agrees)
  missingTestFn: 'throw',
  // unverified: track-05 L311 (runtime corpus `collection-async-describe` agrees)
  asyncDescribe: 'throw',
  // unverified: track-01 L189
  nonPromiseReturn: 'fail',
  // unverified: track-05 L319
  retry: { timing: 'deferred', logErrorsBeforeRetry: false, keepEarlierErrors: false },
  // unverified: track-01 L193
  allowOnly: 'always',
  // unverified: track-05 L317
  maxConcurrency: 5,
  // unverified: track-07 L462
  unawaitedAsyncAssertion: 'ignore',
  // unverified: track-05 L314 (runtime corpus `hook-teardowns` agrees)
  hookReturnsCleanup: false,
  // unverified: track-11 L521
  injectGlobals: true,
  collect: {
    // unverified: track-05 L311 (runtime corpus `describe-body` agrees)
    describeBody: 'immediate',
    // unverified: track-05 Findings L46 (runtime corpus `collection-describe-return-value` agrees)
    describeReturnValue: 'error',
    // unverified: track-05 L312 (runtime corpus `collection-test-after-start` agrees)
    lateRegistration: 'fail-file',
    // unverified: track-05 L312 (runtime corpus `collection-describe-hooks-only` agrees)
    emptyDescribe: 'fail-file-if-hooks',
    // unverified: track-05 L47 (runtime corpus `collection-nested-test` agrees)
    nestedInTest: 'fail-test',
    // unverified: track-05 L57 (runtime corpus `collection-todo-with-fn` agrees)
    todoWithFn: 'throw',
  },
  hooks: {
    // unverified: track-05 L314 (runtime corpus `hook-failures` agrees)
    afterError: 'continue',
    // unverified: track-05 L314 (runtime corpus `hook-failures` agrees)
    beforeAllError: 'attach-to-tests',
    // unverified: track-12 L528 (runtime corpus `hook-failures` agrees)
    nestedHooksAfterBeforeAllError: 'run',
    // unverified: track-05 L314 (runtime corpus `hook-failures-after-all` agrees)
    afterAllError: 'unhandled',
    // unverified: not in the research; Jest gives hooks their own timeout
    timeoutCountsTestTimeout: false,
    // unverified: track-12 L528
    skippedBlock: 'run-before-all',
  },
  // unverified: track-05 L317 (runtime corpus `concurrent-grouping` agrees)
  concurrency: { grouping: 'hoist-to-first', limitHooks: false },
  // unverified: track-05 L320
  errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' },
  // unverified: track-12 L528
  focus: { scope: 'file', insideSkip: 'runs' },
  // unverified: track-12 L528
  status: { todoUnderSkip: 'skipped' },
}

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
  timeouts: { test: 5000, hook: 10000, teardown: 10000, catchSyncOverrun: true },
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
  },
  hooks: {
    // unverified: track-05 L314 (runtime corpus `hook-failures` agrees)
    afterError: 'abort-chain',
    // unverified: track-05 L314 (runtime corpus `hook-failures-before-all` agrees)
    beforeAllError: 'skip-subtree',
    // unverified: track-12 L528
    nestedHooksAfterBeforeAllError: 'skip',
    // unverified: track-05 L314
    afterAllError: 'fail-suite',
    // unverified: not in the research; Vitest gives hooks their own timeout
    timeoutCountsTestTimeout: false,
    // unverified: track-12 L528
    skippedBlock: 'none',
  },
  // unverified: track-05 L317 (runtime corpus `concurrent-grouping` agrees)
  concurrency: { grouping: 'consecutive', limitHooks: true },
  // unverified: track-05 L320
  errors: { lateErrors: 'report-run', hasAssertionsWhenFailed: 'check' },
  // unverified: track-12 L528
  focus: { scope: 'suite', insideSkip: 'skipped' },
  // unverified: track-12 L528
  status: { todoUnderSkip: 'todo' },
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
