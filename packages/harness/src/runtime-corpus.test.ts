// B07's corpus check (T5.3, T5.6): every runtime-corpus fixture, run through `@provino/core` under
// the policy of each profile it was recorded with, must give the golden's trace, the golden's
// tests (title path, `dupIndex`, status, location), the golden's file status, and the golden's
// error placement (which tests and whether the file carry errors). Brief 7's "collected trees
// equal the recorded trees" and "every hook-order and failure scenario matches under jest,
// vitest-stack and vitest-list".
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { CoreErrorCode } from '@provino/core'
import { defaultFixturesRoot, findFixtures, readFixture, testFilesFor } from './fixture.ts'
import type { Golden } from './golden.ts'
import { assertRunMatchesGolden, testsWithoutLocation } from './runtime-corpus/compare.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { runUnderCore } from './runtime-corpus/run-core.ts'
import { pairLabel } from './test-support.ts'

/**
 * The collection error core reports for each fixture and profile whose golden is a crash (Jest
 * fails the whole file at collection), by `fixture (profile)`. Core's messages are neutral, so the
 * code is what says it failed for the right reason. The keys must be exactly the pairs whose
 * `fixture.json` has `expectCrash` (checked below), so an entry cannot go stale.
 */
const COLLECTION_ERROR_CODES: Readonly<Record<string, CoreErrorCode>> = {
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
const UNLOCATED_TESTS: Readonly<Record<string, readonly string[]>> = {
  'runtime/timeouts (jest)': ['timeouts.jest.test.ts::test over its timeout#0'],
}

const root = path.join(defaultFixturesRoot(), 'runtime')
const dirs = await findFixtures(root)
const fixtures = await Promise.all(dirs.map((dir) => readFixture(dir)))

test('the runtime corpus is there', () => {
  assert.ok(dirs.length >= 20, `expected the B07 corpus under ${root}, found ${dirs.length}`)
})

test('the collection error codes are for exactly the pairs that expect a crash', () => {
  const expectCrash = fixtures.flatMap((fixture) =>
    fixture.manifest.runners
      .filter((profile) => fixture.manifest.expectCrash?.[profile] !== undefined)
      .map((profile) => pairLabel(fixture, profile)),
  )
  assert.deepEqual(Object.keys(COLLECTION_ERROR_CODES).toSorted(), expectCrash.toSorted())
})

test('the tests named as having no location belong to pairs in the corpus', () => {
  const labels = new Set(
    fixtures.flatMap((fixture) =>
      fixture.manifest.runners.map((profile) => pairLabel(fixture, profile)),
    ),
  )
  assert.deepEqual(
    Object.keys(UNLOCATED_TESTS).filter((label) => !labels.has(label)),
    [],
  )
})

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    for (const profile of fixture.manifest.runners) {
      test(profile, async () => {
        const label = pairLabel(fixture, profile)
        const goldenPath = path.join(fixture.dir, '__goldens__', `${profile}.json`)
        const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as Golden
        const files = testFilesFor(fixture.files, profile)
        const [testFile] = files
        assert.ok(testFile !== undefined && files.length === 1, 'one test file per profile')
        assert.deepEqual(
          testsWithoutLocation(golden),
          UNLOCATED_TESTS[label] ?? [],
          'the tests the golden has no location for',
        )
        const run = await runUnderCore(
          path.join(fixture.dir, testFile),
          fixture.dir,
          corePolicyFor[profile],
        )
        const collectionErrorCode = COLLECTION_ERROR_CODES[label]
        assertRunMatchesGolden(run, golden, {
          testFile,
          ...(collectionErrorCode === undefined ? {} : { collectionErrorCode }),
        })
      })
    }
  })
}
