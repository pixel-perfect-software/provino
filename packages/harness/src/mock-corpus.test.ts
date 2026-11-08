// B13a's corpus check (T4.3, T4.4): every counted mocking fixture, run through `@provino/core` with
// `jest` or `vi` over `@provino/mock` under the profile's `MockPolicy` (Jest's `jest` is the one
// `jestGlobals` ships), must observe what the real runner recorded: each case's line equals the
// golden's trace line, in the golden's order, and every test the golden lists ran with the golden's
// status. The bar is every case except the declared divergences below, each pinned to the exact
// line the engine may give, which fail the check the day they stop differing or differ otherwise.
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  defaultFixturesRoot,
  type FixtureProfile,
  findFixtures,
  readFixture,
  testFilesFor,
} from './fixture.ts'
import { readGolden } from './golden.ts'
import {
  assertFileOutcome,
  assertTestsMatchGolden,
  compareObservations,
  declaredProblems,
  isModFixture,
  isTimerFixture,
  sameOrder,
  unseenDeclared,
} from './mock-corpus/compare.ts'
import { MOCK_DECLARED as DECLARED } from './mock-corpus/declared.ts'
import { mockPolicyFor } from './mock-corpus/profiles.ts'
import { runMockFile } from './mock-corpus/run-mock.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { pairLabel } from './test-support.ts'

/**
 * The fixture that records `Object.keys` of the `jest` and `vi` objects for T11.10. Nothing reads
 * it yet, so it is not counted.
 */
const UNCOUNTED = new Set(['mocking/api-surface'])

/**
 * The counted cases the corpus has under each profile, exactly. B13a's brief set the bar at Jest 72
 * and Vitest 74 (the spike's 59 and 60 plus the cleanup and hazard cases); the corpus is larger,
 * and a fixture that went silent must fail, so the floor is the real total.
 */
const EXPECTED_COUNTED: Readonly<Partial<Record<FixtureProfile, number>>> = {
  jest: 122,
  vitest: 113,
}

const root = path.join(defaultFixturesRoot(), 'mocking')
const dirs = await findFixtures(root)
const fixtures = (await Promise.all(dirs.map((dir) => readFixture(dir)))).filter(
  (fixture) =>
    !UNCOUNTED.has(fixture.id) && !isModFixture(fixture.id) && !isTimerFixture(fixture.id),
)

const counted: Partial<Record<FixtureProfile, number>> = {}
const seen = new Set<string>()

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    for (const profile of fixture.manifest.runners) {
      test(profile, async () => {
        const label = pairLabel(fixture, profile)
        const golden = await readGolden(fixture.dir, profile)
        const files = testFilesFor(fixture.files, profile)
        const [testFile] = files
        assert.ok(testFile !== undefined && files.length === 1, 'one test file per profile')
        const run = await runMockFile(
          path.join(fixture.dir, testFile),
          fixture.dir,
          corePolicyFor[profile],
          mockPolicyFor[profile],
          profile === 'jest' ? 'jest' : 'vi',
          fixture.manifest.mockCleanup ?? {},
        )

        // Every test ran, with the golden's status: a throw outside `observe` is a failed test.
        const [goldenFile] = golden.files
        assert.ok(goldenFile !== undefined && golden.files.length === 1, 'one golden file')
        assert.ok(run.tests.length > 0, 'the file ran at least one test')
        // A golden that crashed has no tests to compare. Here that is Jest's own teardown
        // `restoreAllMocks()` throwing after the frozen spy (DV7), while its trace holds both
        // lines. Ours must still run at least one test and pass all of them.
        if (fixture.manifest.expectCrash?.[profile] !== undefined) {
          assert.equal(goldenFile.status, 'crashed', 'the exemption is for a crashed golden')
          assert.deepEqual(
            run.tests.filter((t) => t.status !== 'passed').map((t) => t.path),
            [],
            'tests that did not pass',
          )
        } else {
          assertTestsMatchGolden(run, goldenFile)
          assertFileOutcome(run, goldenFile)
        }

        const wanted = golden.trace ?? []
        const results = compareObservations(wanted, run.trace)
        assert.ok(results.length > 0, 'the fixture observed at least one case')
        assert.ok(sameOrder(wanted, run.trace), 'the cases were observed in the golden order')
        counted[profile] = (counted[profile] ?? 0) + results.length
        assert.deepEqual(declaredProblems(label, results, DECLARED, seen), [])
      })
    }
  })
}

test('every declared case is a case of the corpus', () => {
  assert.deepEqual(unseenDeclared(DECLARED, seen), [])
})

test('the corpus is counted: api-surface is not, and the totals are the corpus', () => {
  assert.ok(
    dirs.some((dir) => dir.endsWith('api-surface')),
    'api-surface is recorded',
  )
  assert.ok(!fixtures.some((fixture) => UNCOUNTED.has(fixture.id)))
  assert.deepEqual(counted, EXPECTED_COUNTED)
})
