// B17a's timer check (T4.9, T4.1): every `fixtures/mocking/timers-*` fixture, run through
// `@provino/core` with `jest` or `vi` over `@provino/timers` under the profile's `TimersPolicy`
// (Jest's `jest` is the one `jestGlobals` ships), must observe what the real runner recorded: each
// case's line equals the golden's trace line, in the golden's order, and every test the golden lists
// ran with the golden's status. The run is in a child process, because it fakes that process's own
// timers. The bar is every case except the declared divergences, each pinned to the exact line the
// engine may give.
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
  isTimerFixture,
  sameOrder,
  unseenDeclared,
} from './mock-corpus/compare.ts'
import { pairLabel } from './test-support.ts'
import { TIMER_DECLARED as DECLARED } from './timer-corpus/declared.ts'
import { runTimerChild } from './timer-corpus/run-child.ts'

/**
 * The fixtures that need a Node with `Temporal`. Node 24 has none without `--harmony-temporal`; a
 * Node that ships it (26) takes no flag, so none is passed there.
 */
const NODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'policy/timers-temporal': 'Temporal' in globalThis ? [] : ['--harmony-temporal'],
}

/**
 * The cases the corpus has under each profile, exactly, as `mock-corpus.test.ts` counts its own.
 * T4.9's bar is 22 cases for both policies; a fixture that went silent must fail.
 */
const EXPECTED_COUNTED: Readonly<Partial<Record<FixtureProfile, number>>> = {
  jest: 48,
  vitest: 48,
}

// `timers-temporal` lives with the policy fixtures: it needs a Node with `Temporal`, so it is
// recorded and checked on the main Node only, not on the oldest one `record:mocking` also runs on.
const fixturesRoot = defaultFixturesRoot()
const dirs = [
  ...(await findFixtures(path.join(fixturesRoot, 'mocking'))),
  ...(await findFixtures(path.join(fixturesRoot, 'policy'))).filter((dir) =>
    dir.endsWith('timers-temporal'),
  ),
]
const fixtures = (await Promise.all(dirs.map((dir) => readFixture(dir)))).filter((fixture) =>
  isTimerFixture(fixture.id),
)

const counted: Partial<Record<FixtureProfile, number>> = {}
const seen = new Set<string>()

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    for (const profile of fixture.manifest.runners) {
      test(profile, { timeout: 90_000 }, async () => {
        const label = pairLabel(fixture, profile)
        const golden = await readGolden(fixture.dir, profile)
        const files = testFilesFor(fixture.files, profile)
        const [testFile] = files
        assert.ok(testFile !== undefined && files.length === 1, 'one test file per profile')
        const run = await runTimerChild(
          path.join(fixture.dir, testFile),
          fixture.dir,
          profile,
          NODE_FLAGS[fixture.id] ?? [],
        )

        // Every test ran, with the golden's status: a throw outside `observe` is a failed test.
        const [goldenFile] = golden.files
        assert.ok(goldenFile !== undefined && golden.files.length === 1, 'one golden file')
        assert.ok(run.tests.length > 0, 'the file ran at least one test')
        assertTestsMatchGolden(run, goldenFile)
        assertFileOutcome(run, goldenFile)

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

test('the corpus is counted, and is at least the 22 cases T4.9 asks for under both policies', () => {
  assert.deepEqual(counted, EXPECTED_COUNTED)
  for (const total of Object.values(counted)) assert.ok((total ?? 0) >= 22)
})
