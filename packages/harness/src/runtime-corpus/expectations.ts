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
