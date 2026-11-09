// B07's corpus check (T5.3, T5.6): every runtime-corpus fixture, run through `@provino/core` under
// the policy of each profile it was recorded with, must give the golden's trace, the golden's
// tests (title path, `dupIndex`, status, location), the golden's file status, and the golden's
// error placement (which tests and whether the file carry errors). Brief 7's "collected trees
// equal the recorded trees" and "every hook-order and failure scenario matches under jest,
// vitest-stack and vitest-list".
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  checkedOnNode,
  defaultFixturesRoot,
  findFixtures,
  readFixture,
  testFilesFor,
} from './fixture.ts'
import { readGolden } from './golden.ts'
import { assertRunMatchesGolden, testsWithoutLocation } from './runtime-corpus/compare.ts'
import {
  COLLECTION_ERROR_CODES,
  MESSAGE_FIXTURES,
  UNLOCATED_TESTS,
} from './runtime-corpus/expectations.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { runUnderCore } from './runtime-corpus/run-core.ts'
import { needsChild, runUnderCoreInChild } from './runtime-corpus/run-core-child.ts'
import { pairLabel } from './test-support.ts'

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
      const skip = checkedOnNode(fixture.manifest, profile)
        ? false
        : `the ${profile} golden is checked on Node ${fixture.manifest.nodeMajors?.[profile]?.join(', ')} only`
      test(profile, { skip }, async () => {
        const label = pairLabel(fixture, profile)
        const golden = await readGolden(fixture.dir, profile)
        const files = testFilesFor(fixture.files, profile)
        const [testFile] = files
        assert.ok(testFile !== undefined && files.length === 1, 'one test file per profile')
        assert.deepEqual(
          testsWithoutLocation(golden),
          UNLOCATED_TESTS[label] ?? [],
          'the tests the golden has no location for',
        )
        const run = needsChild(fixture.id)
          ? await runUnderCoreInChild(path.join(fixture.dir, testFile), fixture.dir, profile)
          : await runUnderCore(
              path.join(fixture.dir, testFile),
              fixture.dir,
              corePolicyFor[profile],
            )
        const collectionErrorCode = COLLECTION_ERROR_CODES[label]
        assertRunMatchesGolden(run, golden, {
          testFile,
          ...(collectionErrorCode === undefined ? {} : { collectionErrorCode }),
          ...(MESSAGE_FIXTURES.has(fixture.id) ? { compareMessages: true } : {}),
        })
      })
    }
  })
}
