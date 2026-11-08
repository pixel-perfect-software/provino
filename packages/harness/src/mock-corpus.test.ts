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
  type Declared,
  declaredProblems,
  isModFixture,
  sameOrder,
  unseenDeclared,
} from './mock-corpus/compare.ts'
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
 * The cases whose observation differs from the golden, by `fixture (profile) case`. The check fails
 * on a difference not listed here, on a listed case that now matches the golden, and on a listed
 * case whose line is not the one pinned here, so an entry cannot go stale or widen.
 */
const DECLARED: Readonly<Record<string, Declared>> = {
  // The methods live on one frozen prototype per policy, so a mock's only own key is `mock`.
  'mocking/fn-shape (jest) Object.keys of a mock function': {
    divergence: 'DV8',
    line: '{"id":"Object.keys of a mock function","value":["mock"]}',
  },
  'mocking/fn-shape (vitest) Object.keys of a mock function': {
    divergence: 'DV8',
    line: '{"id":"Object.keys of a mock function","value":["mock"]}',
  },
  // Jest's own teardown `restoreAllMocks()` throws after a frozen spy; ours restores what was
  // installed and does not throw. The throw from the spy itself still matches.
  'mocking/hazard-frozen-spy (jest) restoreAllMocks after the failed spy': {
    divergence: 'DV7',
    line: '{"id":"restoreAllMocks after the failed spy","value":"did not throw"}',
  },
}

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
  (fixture) => !UNCOUNTED.has(fixture.id) && !isModFixture(fixture.id),
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
