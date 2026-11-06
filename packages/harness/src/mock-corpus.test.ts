// B13a's corpus check (T4.3, T4.4): every counted mocking fixture, run through `@provino/core` with
// `jest` or `vi` built from `@provino/mock` under the profile's `MockPolicy`, must observe what the
// real runner recorded: each case's line equals the golden's trace line. The bar is every case
// except the declared divergences below, which fail the check the day they stop differing.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  defaultFixturesRoot,
  type Fixture,
  type FixtureProfile,
  findFixtures,
  readFixture,
  testFilesFor,
} from './fixture.ts'
import type { Golden } from './golden.ts'
import { compareObservations } from './mock-corpus/compare.ts'
import { mockPolicyFor } from './mock-corpus/profiles.ts'
import { runMockFile } from './mock-corpus/run-mock.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'

/**
 * The fixture that records `Object.keys` of the `jest` and `vi` objects for T11.10. Nothing reads
 * it yet, so it is not counted.
 */
const UNCOUNTED = new Set(['mocking/api-surface'])

/**
 * The cases whose observation differs from the golden, by `fixture (profile) case`, each with the
 * DIVERGENCES row that declares it. The check fails on a difference not listed here and on a listed
 * case that now matches, so an entry cannot go stale.
 */
const DECLARED: Readonly<Record<string, string>> = {
  // The methods live on one frozen prototype per policy, so a mock's only own key is `mock`.
  'mocking/fn-shape (jest) Object.keys of a mock function': 'DV8',
  'mocking/fn-shape (vitest) Object.keys of a mock function': 'DV8',
  // Jest's own teardown `restoreAllMocks()` throws after a frozen spy; ours restores what was
  // installed and does not throw. The throw from the spy itself still matches.
  'mocking/hazard-frozen-spy (jest) restoreAllMocks after the failed spy': 'DV7',
}

/** The totals the bar asks for (B13a: Jest 72, Vitest 74 of the corpus's 96 each). */
const MINIMUM_COUNTED: Readonly<Partial<Record<FixtureProfile, number>>> = {
  jest: 72,
  vitest: 74,
}

function pairLabel(fixture: Fixture, profile: FixtureProfile): string {
  return `${fixture.id} (${profile})`
}

const root = path.join(defaultFixturesRoot(), 'mocking')
const dirs = await findFixtures(root)
const fixtures = (await Promise.all(dirs.map((dir) => readFixture(dir)))).filter(
  (fixture) => !UNCOUNTED.has(fixture.id),
)

const counted: Partial<Record<FixtureProfile, number>> = {}
const seen = new Set<string>()

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    for (const profile of fixture.manifest.runners) {
      test(profile, async () => {
        const label = pairLabel(fixture, profile)
        const golden = JSON.parse(
          await readFile(path.join(fixture.dir, '__goldens__', `${profile}.json`), 'utf8'),
        ) as Golden
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
        const results = compareObservations(golden.trace ?? [], run)
        counted[profile] = (counted[profile] ?? 0) + results.length
        const undeclared: string[] = []
        const nowMatching: string[] = []
        for (const result of results) {
          const key = `${label} ${result.id}`
          seen.add(key)
          const divergence = DECLARED[key]
          if (result.matches) {
            if (divergence !== undefined) nowMatching.push(`${key} (${divergence})`)
          } else if (divergence === undefined) {
            undeclared.push(`${key}\n  want ${result.want}\n  got  ${result.got}`)
          }
        }
        assert.deepEqual(undeclared, [], 'cases that differ from the golden and are not declared')
        assert.deepEqual(nowMatching, [], 'declared cases that now match the golden')
      })
    }
  })
}

test('every declared case is a case of the corpus', () => {
  const unknown = Object.keys(DECLARED).filter((key) => !seen.has(key))
  assert.deepEqual(unknown, [])
})

test('the corpus is counted: api-surface is not, and the totals reach the bar', () => {
  assert.ok(
    dirs.some((dir) => dir.endsWith('api-surface')),
    'api-surface is recorded',
  )
  assert.ok(!fixtures.some((fixture) => UNCOUNTED.has(fixture.id)))
  for (const [profile, minimum] of Object.entries(MINIMUM_COUNTED)) {
    const total = counted[profile as FixtureProfile] ?? 0
    assert.ok(total >= minimum, `${profile}: ${total} counted cases, expected at least ${minimum}`)
  }
})
