// The evidence for the `core` and `lazy` slices (T1.7). The runtime corpus (B07) runs Provino's
// core under each value and compares with goldens recorded from both runners, so a flipped value
// that changes a run is caught there; `fixtures/policy/core-*` record what it can't tell apart.
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'
import { errorsOf, hasTest, oneOf, statusOf, testOf, timeoutOf } from '../observe.ts'

const hookOrder = (...fixtures: readonly string[]) => [
  golden('core-hooks'),
  corpus('runtime', ...fixtures.map((name) => `runtime/${name}`)),
]

export const coreClaims: Claims = {
  'core.hookOrder.beforeAll': hookOrder('hook-order', 'hook-failures-before-all'),
  'core.hookOrder.beforeEach': hookOrder('hook-order', 'hook-failures'),
  'core.hookOrder.afterEach': hookOrder('hook-order'),
  'core.hookOrder.afterAll': hookOrder('hook-order', 'hook-failures-after-all'),
  'core.eachHooksForConcurrent': corpus('runtime', 'runtime/concurrent-grouping'),
  'core.firstArg': each(golden('core-test-fn'), [
    golden('core-test-fn'),
    corpus('runtime', 'runtime/test-callbacks'),
  ]),
  'core.allowGeneratorFns': golden('core-test-fn'),
  'core.timeouts.test': golden('core-timeouts', {
    read: (g) =>
      timeoutOf(g, ...(g.runner === 'jest' ? [] : ['timeouts']), 'a test over the default timeout'),
  }),
  'core.timeouts.hook': golden('core-timeouts', {
    read: (g) =>
      timeoutOf(
        g,
        ...(g.runner === 'jest' ? [] : ['timeouts']),
        'a hook over the default timeout',
        't',
      ),
  }),
  'core.timeouts.teardown': each(
    own(
      'packages/core/src/executor/timeouts.test.ts',
      'timeouts.teardown',
      'Jest has no teardowns of its own to bound (a hook returns no cleanup, hookReturnsCleanup is false); the value bounds the ones Provino adds, such as lazy teardowns',
    ),
    // A cleanup a beforeEach returns runs under the hook timeout: it fails at 10000 ms.
    golden('core-timeouts', {
      read: (g) => timeoutOf(g, 'timeouts', 'a cleanup over the hook timeout', 't'),
    }),
  ),
  'core.timeouts.catchSyncOverrun': corpus('runtime', 'runtime/timeouts'),
  'core.timeouts.zero': golden('core-timeouts', {
    // A test given 0 that runs past 5000 ms: failed at the default, or passed with no deadline.
    read: (g) => {
      const status = statusOf(
        g,
        ...(g.runner === 'jest' ? [] : ['timeouts']),
        'a test with a timeout of 0',
      )
      return oneOf(status, [
        ['default', status === 'failed'],
        ['none', status === 'passed'],
      ])
    },
  }),
  'core.nameSeparator': golden('core-test-fn'),
  'core.testNamePatternFlags': golden('core-name-pattern', {
    // `-t Upper`: the lower-case name runs only under a case-insensitive match.
    read: (g) => {
      const status = statusOf(g, 'upper case')
      return oneOf(status, [
        ['i', status === 'passed'],
        ['', status === 'skipped'],
      ])
    },
  }),
  'core.missingTestFn': corpus('runtime', 'runtime/collection-missing-fn'),
  'core.asyncDescribe': corpus('runtime', 'runtime/collection-async-describe'),
  'core.nonPromiseReturn': golden('core-test-fn', {
    read: (g) => {
      const status = statusOf(g, 'a function that returns a value')
      return oneOf(status, [
        ['fail', status === 'failed'],
        ['ignore', status === 'passed'],
      ])
    },
  }),
  'core.formatEachTitle': pending('B17a', "jest-each's and Vitest's .each titles are T5.4's"),
  'core.eachTitleTruncate': each(golden('core-test-fn'), [
    golden('core-test-fn'),
    golden('defaults', { case: 'core.eachTitleTruncate' }),
  ]),
  'core.retry.timing': golden('core-retry'),
  'core.retry.logErrorsBeforeRetry': each(
    // The first attempt's error is in Jest's output only with logErrorsBeforeRetry set.
    golden('core-retry-log', {
      read: (g) => {
        const shown = String(g.observed?.stderr)
        if (!shown.includes('first attempt (logErrorsBeforeRetry)')) {
          return 'the option set on purpose was not logged either'
        }
        return shown.includes('first attempt (default options)')
      },
    }),
    // The first attempt's error reaches the reporter with the passed retry's result.
    golden('core-retry', {
      read: (g) => errorsOf(g, 'fails once, then passes').includes('Error: first attempt'),
    }),
  ),
  'core.retry.keepEarlierErrors': golden('core-retry', {
    read: (g) => errorsOf(g, 'fails every attempt').includes('Error: attempt 1'),
  }),
  'core.allowOnly': corpus('runtime', 'runtime/only-scope'),
  'core.maxConcurrency': [corpus('runtime', 'runtime/concurrent-limit'), golden('defaults')],
  'core.unawaitedAsyncAssertion': golden('expect/policies/unawaited-async', {
    // An unawaited `resolves` that would pass, still pending when the test ends.
    read: (g) => {
      const status = statusOf(g, 'unawaited async assertions', 'unawaited resolves that would pass')
      return oneOf(status, [
        ['ignore', status === 'passed'],
        ['fail', status === 'failed'],
      ])
    },
  }),
  'core.hookReturnsCleanup': corpus('runtime', 'runtime/hook-teardowns'),
  'core.injectGlobals': golden('defaults'),
  'core.doneDeprecatedMessage': pending(
    'B17a',
    "T5.7 builds Jest's done errors and Vitest's callable context; neither runner prints a warning for a done callback, which T5.7's fixture records",
  ),
  'core.collect.describeBody': corpus('runtime', 'runtime/describe-body'),
  'core.collect.describeReturnValue': corpus('runtime', 'runtime/collection-describe-return-value'),
  'core.collect.lateRegistration': corpus('runtime', 'runtime/collection-test-after-start'),
  'core.collect.emptyDescribe': corpus(
    'runtime',
    'runtime/collection-describe-hooks-only',
    'runtime/collection-describe-empty',
  ),
  'core.collect.nestedInTest': corpus('runtime', 'runtime/collection-nested-test'),
  'core.collect.todoWithFn': corpus('runtime', 'runtime/collection-todo-with-fn'),
  'core.collect.eachTableError': golden('core-outcomes', {
    // An empty table: one failing test under the raw title, or nothing at all.
    read: (g) =>
      hasTest(g, 'an empty table %s')
        ? oneOf(statusOf(g, 'an empty table %s'), [
            ['failing-test', statusOf(g, 'an empty table %s') === 'failed'],
          ])
        : 'lenient',
  }),
  'core.hooks.afterError': corpus('runtime', 'runtime/hook-failures'),
  'core.hooks.beforeAllError': corpus('runtime', 'runtime/hook-failures'),
  // The runtime corpus can't tell Vitest's apart: no fixture there has hooks under a failing
  // beforeAll whose effect a golden shows.
  'core.hooks.nestedHooksAfterBeforeAllError': each(
    [golden('core-hooks'), corpus('runtime', 'runtime/hook-failures')],
    golden('core-hooks'),
  ),
  'core.hooks.afterAllError': corpus('runtime', 'runtime/hook-failures-after-all'),
  'core.hooks.timeoutCountsTestTimeout': corpus('runtime', 'runtime/timeouts'),
  'core.hooks.skippedBlock': corpus('runtime', 'runtime/collection-describe-hooks-only'),
  'core.concurrency.grouping': corpus('runtime', 'runtime/concurrent-grouping'),
  'core.concurrency.limitHooks': each(
    inert(
      'core.eachHooksForConcurrent',
      false,
      'Jest runs no each-hooks around a concurrent test, so no hook could take a slot',
    ),
    pending(
      'D47',
      'no fixture tells it apart: a concurrent test runs its own hooks inside its slot, so the peak is the same either way',
    ),
  ),
  'core.errors.lateErrors': golden('core-late-error', {
    // The first test's timer throws while the second runs: the first test fails, or every test
    // passes and the run fails.
    read: (g) =>
      oneOf(g.observed, [
        ['fail-owner', statusOf(g, 'leaves a throwing timer behind') === 'failed'],
        [
          'report-run',
          statusOf(g, 'leaves a throwing timer behind') === 'passed' &&
            statusOf(g, 'is running when it fires') === 'passed' &&
            g.observed?.exitCode === 1,
        ],
      ]),
  }),
  'core.errors.hasAssertionsWhenFailed': golden('core-outcomes', {
    // A test that throws before any assertion: does `hasAssertions` add its own error?
    read: (g) => {
      const errors = errorsOf(g, 'throws before any assertion')
      return oneOf(errors, [
        ['skip', errors.length === 1],
        ['check', errors.length === 2],
      ])
    },
  }),
  'core.focus.scope': golden('core-focus', {
    // A test.only inside describe.skip: does the test outside still run?
    read: (g) => {
      const status = statusOf(g, 'a test outside the skipped describe with a test.only')
      return oneOf(status, [
        ['file', status === 'passed'],
        ['suite', status === 'skipped'],
      ])
    },
  }),
  'core.focus.insideSkip': golden('core-focus', {
    // A describe.only inside describe.skip: does its test run?
    read: (g) => {
      const status = statusOf(
        g,
        'skipped describe',
        'only describe inside it',
        'a test with no mode',
      )
      return oneOf(status, [
        ['runs', status === 'passed'],
        ['skipped', status === 'skipped' || status === 'notRun'],
      ])
    },
  }),
  'core.status.todoUnderSkip': golden('core-outcomes', {
    read: (g) => {
      const status = statusOf(g, 'a skipped describe', 'a todo inside it')
      return oneOf(status, [
        ['skipped', status === 'skipped'],
        ['todo', status === 'todo'],
      ])
    },
  }),
  'core.status.expectFail': golden('core-outcomes', {
    // A .failing/.fails test whose body passes and whose beforeEach throws.
    read: (g) => {
      const status = statusOf(
        g,
        'a beforeEach that throws',
        'an expected failure whose body passes',
      )
      return oneOf(status, [
        ['body', status === 'failed'],
        ['attempt', status === 'passed'],
      ])
    },
  }),
  'core.locationFrame': golden('core-location', {
    // The helper's `test` call is at 9:5 in helper.ts; the helper call is at 3:1 in the test file.
    read: (g) => {
      const location = testOf(g, 'registered by a helper').location
      return oneOf(location, [
        ['caller', location?.line === 9 && location.column === 5],
        ['test-file', location?.line === 3 && location.column === 1],
      ])
    },
  }),
  'core.orderHooks': own(
    'packages/core/src/executor/executor.test.ts',
    'orderHooks',
    "Provino's escape hatch for an order no HookOrder names; null hands the order to hookOrder",
  ),
}

export const lazyClaims: Claims = {
  'lazy.readInBeforeAll': pending(
    'T6.5',
    "Provino's lazy variables are its own API, so the value is ours and needs a test, which comes with @provino/lazy's reads (T6.5, no bundle yet)",
  ),
}
