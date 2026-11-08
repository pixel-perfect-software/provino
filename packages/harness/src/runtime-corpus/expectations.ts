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
}
