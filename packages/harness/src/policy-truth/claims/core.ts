// The evidence for the `core` and `lazy` slices (T1.7). The runtime corpus (B07) runs Provino's
// core under each value and compares with goldens recorded from both runners, so a flipped value
// that changes a run is caught there; `fixtures/policy/core-*` record what it can't tell apart.
import { equal as assertEqual } from 'node:assert'
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util'
import { jestShuffle, shapeTestError } from '@provino/dialect-jest/runtime'
import { vitestPolicy } from '@provino/dialect-vitest'
import { neutralPolicy } from '@provino/policy'
import type { Golden } from '../../golden.ts'
import { type Claims, corpus, each, golden, own, pending } from '../evidence.ts'
import {
  errorsOf,
  hasTest,
  observedOf,
  oneOf,
  refTo,
  statusOf,
  testOf,
  timeoutOf,
} from '../observe.ts'

/**
 * What the `globalSetup` listener of `cli/rejection-*-process-listener` heard (its `heard.txt`), or
 * `null` when it heard nothing.
 */
const heardOf = (g: Golden): string | null => observedOf(g).files?.['heard.txt'] ?? null

/** The seed `cli/randomize-seed-flat` ran with (`--seed=1234`). */
const FLAT_SEED = 1234

/** Whether a behaviour ref is `name`, exported from `@provino/dialect-jest/runtime`. */
const isJestRuntimeRef = (value: unknown, name: string): boolean =>
  refTo('@provino/dialect-jest/runtime', name)(value)

/**
 * Whether the ref (the dialect's `core.shuffle`) is jest-circus's shuffle: `cli/randomize-seed-flat`
 * is 30 plain top-level tests, so the order Jest ran them in is the shuffle of the declared order
 * (`t01`…`t30`, which sorts as declared) under the seed. A value that is not the dialect's own
 * `jestShuffle` ref (`null` for no shuffle, a ref to another function) shows nothing of the sort.
 */
const shuffleMatches = (g: Golden, value: unknown): boolean => {
  if (!isJestRuntimeRef(value, 'jestShuffle')) return false
  const results = observedOf(g).json?.['.harness-out/jest.json'] as
    | {
        readonly testResults?: readonly {
          readonly assertionResults?: readonly { title: string }[]
        }[]
      }
    | null
    | undefined
  const ran = (results?.testResults?.[0]?.assertionResults ?? []).map((test) => test.title)
  if (ran.length !== 30) throw new Error(`${g.suite} (${g.runner}) did not run 30 tests`)
  return isDeepStrictEqual(jestShuffle(FLAT_SEED)(ran.toSorted()), ran)
}

/**
 * Whether the ref (the dialect's `core.shapeTestError`) is what turns a failed `node:assert` call
 * into Jest's text: it is the dialect's own `shapeTestError` ref, and what that function makes of a
 * real `assert.equal(1, 2)` failure is the error `cli/node-assert` recorded for its `equal` test, up
 * to its stack frames (`null`, or a ref to another function, leaves Node's own text).
 */
const nodeAssertMatches = (g: Golden, value: unknown): boolean => {
  if (!isJestRuntimeRef(value, 'shapeTestError')) return false
  // The golden's message is the failure text up to its stack frames.
  const [recorded] = errorsOf(g, 'equal')
  if (recorded === undefined) throw new Error(`${g.suite} (${g.runner}) recorded no failure`)
  let thrown: unknown
  try {
    assertEqual(1, 2)
  } catch (error) {
    thrown = error
  }
  const shaped = shapeTestError(thrown, { expand: false }) as { readonly message: string }
  // Colour is the terminal's and FORCE_COLOR's, not the claim's: compare the plain text.
  return (
    stripVTControlCharacters(shaped.message).split(/\n\s+at /)[0] ===
    stripVTControlCharacters(recorded)
  )
}

/** Whether a test that fails every attempt reports the first attempt's error (`core-retry`). */
const keptByRetryGolden = golden('core-retry', {
  read: (g) => errorsOf(g, 'fails every attempt').includes('Error: attempt 1'),
})

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
      'packages/dialect-jest/src/dialect.test.ts',
      'timeouts.teardown',
      5000,
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
  // The ref flips to the neutral formatter (`flip.ts` `REF_FLIPS`): the runtime corpus titles every
  // .each test through the dialect's formatter and compares it with the runner's own title, so the
  // neutral one fails it. Not listed: the fixtures whose cases a title formatted one row at a time
  // cannot reach yet (a mixed table, a tagged template with a % in its title: Jest; a null row in
  // `.for`: Vitest), which wait for core to hand the formatter the table.
  'core.formatEachTitle': each(
    corpus(
      'runtime',
      'runtime/each-tokens',
      'runtime/each-placeholder-counts',
      'runtime/each-objects',
      'runtime/each-templates',
      'runtime/each-template-syntax',
      'runtime/each-describe',
      'runtime/each-truncate',
      'runtime/each-values',
      'runtime/each-json-bigint',
    ),
    corpus(
      'runtime',
      'runtime/each-tokens',
      'runtime/each-placeholder-counts',
      'runtime/each-objects',
      'runtime/each-mixed-rows',
      'runtime/each-templates',
      'runtime/each-template-percent',
      'runtime/each-describe',
      'runtime/each-truncate',
      'runtime/each-values',
      'runtime/each-for',
    ),
  ),
  'core.eachTitleTruncate': each(golden('core-test-fn'), [
    golden('core-test-fn'),
    golden('defaults', { case: 'core.eachTitleTruncate' }),
  ]),
  'core.retry.timing': [golden('core-retry'), corpus('runtime', 'runtime/retry-order')],
  // Vitest 5.0.5 never calls a function `retry.condition` and retries every failure; flipping to
  // `call` makes core ask the function, which the recorded trace doesn't show. Jest has no
  // condition, so its value is the neutral one and a core test pins what each value does.
  'core.retry.functionCondition': each(
    own(
      'packages/core/src/executor/retry-timing.test.ts',
      'functionCondition',
      'call',
      'Jest has no retry condition, so nothing reads the value; it is the neutral `call`, which core calls the function under',
    ),
    corpus('runtime', 'runtime/retry-condition-function'),
  ),
  // The text after the test's name in the warning for an ignored function condition: Provino's own,
  // so a test pins each dialect's. Jest has no condition to warn about and keeps the neutral text.
  'core.retry.functionConditionWarning': each(
    own(
      'packages/dialect-jest/src/dialect.test.ts',
      'functionConditionWarning',
      neutralPolicy.core.retry.functionConditionWarning,
      'Jest has no retry condition, so nothing warns; the value is the neutral text',
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'functionConditionWarning',
      vitestPolicy.core?.retry?.functionConditionWarning,
      "Provino's own warning, which names the runner whose outcome the dialect keeps (D7)",
    ),
  ),
  // Whether the errors of a retried attempt stay on the result. Jest drops them from its output
  // unless `logErrorsBeforeRetry` is set (a file sets it with `DefaultRetry.keepEarlierErrors`).
  'core.retry.keepEarlierErrors': each(
    [
      keptByRetryGolden,
      golden('core-retry-log', {
        read: (g) => {
          const shown = String(g.observed?.stderr)
          if (!shown.includes('first attempt (logErrorsBeforeRetry)')) {
            return 'the option set on purpose was not logged either'
          }
          return shown.includes('first attempt (default options)')
        },
      }),
      corpus('runtime', 'runtime/retry-order'),
    ],
    [keptByRetryGolden, corpus('runtime', 'runtime/retry-order')],
  ),
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
  // The text a call to the context throws: Vitest's context is a function that throws it, Jest has
  // no context and so no text (`runtime/done-callback`, B17a).
  'core.doneDeprecatedMessage': golden('runtime/done-callback', {
    read: (g) => {
      const hit = errorsOf(g, 'done called synchronously').find((message) =>
        message.includes('callback is deprecated'),
      )
      return hit === undefined ? null : hit.replace(/^Error: /, '')
    },
  }),
  // How the runtime prints a value in the messages it builds. Jest's is pretty-format at depth 3
  // (the corpus compares the `done` errors' text, so the neutral printer fails it); Vitest builds
  // none of those messages, so its value is Provino's neutral one (the dialect's test pins it).
  'core.formatValue': each(
    corpus('runtime', 'runtime/done-callback'),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'formatValue',
      neutralPolicy.core.formatValue,
      'Vitest has no `done` and ignores a returned value, so nothing prints a value',
    ),
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
    // Core reads it for every hook and test body (`executor.ts` builds its limiters from it), so
    // it isn't inert, and no runtime-corpus run tells the values apart.
    pending(
      'Tyler',
      'core reads it for every hook, but Jest runs no each-hooks around a concurrent test, and no fixture found tells the values apart',
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
  'core.errors.processListeners': each(
    [
      // A `globalSetup`'s `unhandledRejection` listener on the process that runs the tests. Three
      // tests leave rejections Node reports only after the run: the listener has them and no test
      // fails (`per-file`), or the runtime, still listening, charges them to their tests.
      golden('cli/rejection-after-run-process-listener', {
        read: (g) =>
          oneOf(g.observed, [
            ['per-file', g.observed?.exitCode === 0 && heardOf(g) !== null],
            ['alongside', statusOf(g, 'leaves a chain that rejects 5 turns later') === 'failed'],
          ]),
      }),
      // A rejection Node reports while the file runs: the listener was taken off the process for
      // the file and never hears it (`per-file`), or it hears it beside the runtime.
      golden('cli/rejection-during-run-process-listener', {
        read: (g) =>
          oneOf(heardOf(g), [
            ['per-file', heardOf(g) === null],
            ['alongside', heardOf(g) !== null],
          ]),
      }),
    ],
    pending(
      'T11.16',
      "Vitest's worker keeps its listeners beside the process's own; not recorded: the neutral value stands",
    ),
  ),
  'core.errors.waitForUnhandledRejections': each(
    // Jest's default: circus waits no macrotask, so the rejections an all-promise file left are
    // reported after the run, and the process's own listener hears them; with the wait (the
    // option on, `cli/rejection-wait-for-unhandled-rejections`) circus charges them while it
    // listens and the listener hears none.
    golden('cli/rejection-after-run-process-listener', {
      read: (g) =>
        oneOf(heardOf(g), [
          [false, heardOf(g) !== null],
          [true, heardOf(g) === null],
        ]),
    }),
    pending('T11.16', 'Vitest has no waitForUnhandledRejections option: the neutral value stands'),
  ),
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
  // Jest's `--randomize --seed`: the order of 30 tests under a seed is what jest-circus's shuffle
  // gives (`cli/randomize-seed-flat`); `null`, the neutral value, shuffles nothing, so it fails.
  // Vitest's own shuffle (`sequence.shuffle`, its own generator) isn't built.
  'core.shuffle': each(
    golden('cli/randomize-seed-flat', { matches: shuffleMatches }),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'core.shuffle',
      null,
      "Vitest's `sequence.shuffle` uses its own generator and isn't built (Vitest dialect, T11.16): the neutral `null` stands",
    ),
  ),
  // A test that fails with `node:assert` reads as jest-circus's `formatNodeAssertErrors` has it
  // (`cli/node-assert`); `null`, the neutral value, leaves Node's `AssertionError [ERR_ASSERTION]`.
  'core.shapeTestError': each(
    golden('cli/node-assert', { matches: nodeAssertMatches }),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'core.shapeTestError',
      null,
      'Vitest reports a node:assert AssertionError as thrown: the neutral `null` stands',
    ),
  ),
  'core.orderHooks': own(
    'packages/core/src/executor/executor.test.ts',
    'orderHooks',
    null,
    "Provino's escape hatch for an order no HookOrder names; null hands the order to hookOrder",
  ),
  // The turns a promise chain gets between two functions (`runtime/microtask-turns`, under node and
  // jsdom): each trace line is the count from one function's end to the next one's start, the sum
  // of the boundaries passed, so a turn more at any one of them changes a line. The recordings give
  // the sums (hookEnd + hookStart = 21, fnEnd + hookStart = 20, hookEnd + testEnd + testStart +
  // hookStart = 67, …), not where each turn sits: the split follows jest-circus's code, one
  // dispatch of 7 turns before a hook or a test's function.
  // One claim per leaf, never one for the group: a group claim's golden would vouch for every leaf
  // under it, the research values of B23f included.
  ...Object.fromEntries(
    ['hookStart', 'hookEnd', 'fnStart', 'fnEnd', 'testStart', 'testEnd'].map((key) => [
      `core.boundaryTurns.${key}`,
      each(
        corpus('runtime', 'runtime/microtask-turns', 'runtime/microtask-turns-jsdom'),
        pending(
          'T11.16',
          "Vitest's turns between hooks and tests aren't recorded: the neutral 0s stand",
        ),
      ),
    ]),
  ),
  // B23f Phase 1: the boundaries beyond a test's own, and the event counts of every boundary.
  // Jest's are #114's live counts (D133) until Phase 5 records them (`runtime/microtask-turns-*`).
  ...Object.fromEntries(
    [
      'skippedTest',
      'suiteStart',
      'suiteEnd',
      'runStart',
      'retry',
      ...['hookStart', 'hookEnd', 'fnStart', 'fnEnd', 'testStart', 'testEnd'].map(
        (key) => `events.${key}`,
      ),
      ...['skippedTest', 'suiteStart', 'suiteEnd', 'runStart', 'retry'].map(
        (key) => `events.${key}`,
      ),
    ].map((key) => [
      `core.boundaryTurns.${key}`,
      each(
        pending(
          'B23f-turns',
          "jest-circus's turns at this boundary are research values (#114's counts, D133) until Phase 5 records them",
        ),
        pending('T11.16', "Vitest's turns aren't recorded: the neutral 0s stand"),
      ),
    ]),
  ),
}

export const lazyClaims: Claims = {
  'lazy.readInBeforeAll': pending(
    'T6.5',
    "Provino's lazy variables are its own API, so the value is ours and needs a test, which comes with @provino/lazy's reads (T6.5, no bundle yet)",
  ),
}
