// What the runtime corpus pins beyond the goldens (B07), shared by `runtime-corpus.test.ts` and
// T1.7's `policy-truth/corpora.ts`, so both hold a run to the same expectations.
import type { CoreErrorCode } from '@provino/core'

/**
 * The collection error core reports for each fixture and profile whose golden is a crash (Jest
 * fails the whole file at collection), by `fixture (profile)`. Core's messages are neutral, so the
 * code is what says it failed for the right reason. The keys must be exactly the pairs whose
 * `fixture.json` has `expectCrash` (checked below), so an entry cannot go stale.
 */
export const COLLECTION_ERROR_CODES: Readonly<Record<string, CoreErrorCode>> = {
  'runtime/collection-async-describe (jest)': 'CORE_ASYNC_DESCRIBE',
  'runtime/collection-describe-return-value (jest)': 'CORE_DESCRIBE_RETURN_VALUE',
  'runtime/collection-missing-fn (jest)': 'CORE_MISSING_TEST_FN',
  'runtime/collection-todo-with-fn (jest)': 'CORE_TODO_WITH_FN',
}

/**
 * The tests a golden has no location for, by `fixture (profile)`, as `testKey` prints them. The
 * comparison skips a location the golden lacks, so every such test is named here and a golden that
 * loses locations (a recorder regression) fails instead of switching the check off. Jest's JSON
 * drops the location of a test that timed out.
 */
export const UNLOCATED_TESTS: Readonly<Record<string, readonly string[]>> = {
  'runtime/timeouts (jest)': ['timeouts.jest.test.ts::test over its timeout#0'],
  // Jest's JSON drops the location of a test whose failure message is a rejected string or an
  // error made by the runner (a timeout, `done` plus a returned value).
  'runtime/done-callback (jest)': [
    'done.test.ts::done and a returned promise#0',
    'done.test.ts::done and a returned value#0',
    'done.test.ts::done never called#0',
    'done.test.ts::an async function that declares done#0',
    'done.test.ts::a generator that declares a parameter#0',
  ],
}

/**
 * The fixtures whose error text is compared with the golden's, because the words are the dialects'
 * own (T5.7: Jest's `done` errors, Vitest's callable context). The others compare where errors are.
 */
export const MESSAGE_FIXTURES: ReadonlySet<string> = new Set([
  'runtime/done-callback',
  'runtime/done-each',
  'runtime/done-hooks',
  'runtime/context-shape',
])

/**
 * The fixtures whose stderr is Jest's `logErrorsBeforeRetry` output: the errors core keeps for the
 * reporter (`retryErrors`) must be the ones Jest printed.
 */
export const RETRY_LOG_FIXTURES: ReadonlySet<string> = new Set(['runtime/retry-log-errors'])

/**
 * The trace core gives where the real runner has a bug that core does not copy (D7), by
 * `fixture (profile)`. (Vitest 5.0.5 never calls a function given as `retry.condition` and retries
 * every failure; that is not declared here: the Vitest dialect's `retry.functionCondition` is
 * `ignore-warn`, which keeps that outcome, D7, and `runtime/retry-condition-function` holds it.)
 */
export const DECLARED_TRACES: Readonly<Record<string, readonly string[]>> = {
  // Vitest tests the user's `g` or `y` RegExp itself, so its `lastIndex` carries: the same failure is
  // retried once and then not, and a RegExp shared by two tests carries it from one to the other
  // (`shared next` is not retried at all, after a test that matched it once). Core tests a copy.
  'runtime/retry-condition-regexp-global (vitest)': [
    'no flag #1',
    'no flag #2',
    'no flag #3',
    'no flag #4',
    'global flag #1',
    'global flag #2',
    'global flag #3',
    'global flag #4',
    'sticky flag #1',
    'sticky flag #2',
    'sticky flag #3',
    'sticky flag #4',
    'shared first #1',
    'shared first #2',
    'shared next #1',
    'shared next #2',
    'shared next #3',
    'shared next #4',
  ],
}
