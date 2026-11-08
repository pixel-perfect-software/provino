// B13b's module-mock check (T4.7): every recorded `mod-*` fixture, run through the fake loader
// (real resolver, real hoister, real module-mock registry) and `@provino/core`, must observe what
// the real runner recorded: each case's line equals the golden's trace line, in the golden's order,
// every test the golden lists ran with the golden's status, the file ended with the golden's status
// and errors where the golden has them, and a golden that crashed crashed here for the same cause.
// The bar is every case except the declared divergences below, each pinned to the exact line we may
// give, which fail the check the day they stop differing or differ otherwise. Two broken engines
// must disagree with the goldens on an exact number of cases, so the check cannot pass by observing
// nothing (see the end of this file).
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import { jestHoistPolicy, jestPolicy } from '@provino/dialect-jest'
import { resolvePolicy } from '@provino/policy'
import {
  defaultFixturesRoot,
  type Fixture,
  type FixtureProfile,
  findFixtures,
  readFixture,
  testFilesFor,
} from './fixture.ts'
import { readGolden } from './golden.ts'
import {
  assertFileOutcome,
  assertTestsMatchGolden,
  causeText,
  compareObservations,
  type Declared,
  declaredProblems,
  isModFixture,
  sameOrder,
  unseenDeclared,
} from './mock-corpus/compare.ts'
import { mockPolicyFor, vitestHoistPolicy, vitestModulePolicy } from './mock-corpus/profiles.ts'
import { type ModProfile, runModFile } from './mod-corpus/run-mod.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { pairLabel } from './test-support.ts'

/** The Jest and Vitest profiles the fake loader runs under. */
const PROFILES: Readonly<Partial<Record<FixtureProfile, ModProfile>>> = {
  jest: {
    facade: 'jest',
    core: corePolicyFor.jest,
    mock: mockPolicyFor.jest,
    module: resolvePolicy(jestPolicy).module,
    hoist: jestHoistPolicy,
  },
  vitest: {
    facade: 'vi',
    core: corePolicyFor.vitest,
    mock: mockPolicyFor.vitest,
    module: vitestModulePolicy,
    hoist: vitestHoistPolicy,
  },
}

/**
 * The cases whose observation differs from the golden, by `fixture (profile) case`. The check fails
 * on a difference not listed here, on a listed case that now matches, and on a listed case whose
 * line is not the one pinned here.
 */
const DECLARED: Readonly<Record<string, Declared>> = {
  // Vitest 5.0.5 hoists a helper that calls `vi.mock` and then reads an `import { count as x }`
  // that the helper re-exports with `export { x }` as `undefined`, always. A bug; we keep the
  // binding live, as Jest and a plain module do (the `export { count } from` form is live in both).
  'mocking/mod-reexport-live (vitest) before any change all three read 0': {
    divergence: 'DV11',
    line: '{"id":"before any change all three read 0","value":{"source":0,"reExported":0,"importedThenExported":0}}',
  },
  'mocking/mod-reexport-live (vitest) after the source changes count, both re-exports follow': {
    divergence: 'DV11',
    line: '{"id":"after the source changes count, both re-exports follow","value":{"source":2,"reExported":2,"importedThenExported":2}}',
  },
  'mocking/mod-reexport-live (vitest) a change made through the re-exported function is seen by all three':
    {
      divergence: 'DV11',
      line: '{"id":"a change made through the re-exported function is seen by all three","value":{"source":3,"reExported":3,"importedThenExported":3}}',
    },
}

/** The counted cases the corpus has under each profile, exactly. */
const EXPECTED_COUNTED: Readonly<Partial<Record<FixtureProfile, number>>> = {
  jest: 114,
  vitest: 102,
}

/**
 * How many counted cases each broken engine gets wrong, exactly (of `EXPECTED_COUNTED`, crashed
 * goldens aside). A fixture that stopped observing, or an engine change that makes a broken
 * registry agree with the goldens, moves these.
 */
const EXPECTED_DISAGREEING: Readonly<
  Record<'inert' | 'wrong-values', Readonly<Partial<Record<FixtureProfile, number>>>>
> = {
  inert: { jest: 82, vitest: 73 },
  'wrong-values': { jest: 72, vitest: 72 },
}

/** Per-file deadline: a hang is a real flaw, not something to retry. */
const TIMEOUT_MS = 30_000

const root = path.join(defaultFixturesRoot(), 'mocking')
const dirs = await findFixtures(root)
const fixtures: Fixture[] = (await Promise.all(dirs.map((dir) => readFixture(dir)))).filter(
  (fixture) => isModFixture(fixture.id),
)

const counted: Partial<Record<FixtureProfile, number>> = {}
const seen = new Set<string>()

async function runFixture(
  fixture: Fixture,
  profile: FixtureProfile,
  sabotage?: 'inert' | 'wrong-values',
) {
  const modProfile = PROFILES[profile]
  assert.ok(modProfile !== undefined, `no mod profile for ${profile}`)
  const files = testFilesFor(fixture.files, profile)
  const [testFile] = files
  assert.ok(testFile !== undefined && files.length === 1, 'one test file per profile')
  const golden = await readGolden(fixture.dir, profile)
  const run = await runModFile(fixture, testFile, modProfile, {
    ...(sabotage === undefined ? {} : { sabotage }),
  })
  return { golden, run }
}

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    for (const profile of fixture.manifest.runners) {
      if (profile === 'vitest-list') continue
      test(profile, { timeout: TIMEOUT_MS }, async () => {
        const label = pairLabel(fixture, profile)
        const { golden, run } = await runFixture(fixture, profile)
        const [goldenFile] = golden.files
        assert.ok(goldenFile !== undefined && golden.files.length === 1, 'one golden file')

        const crash = fixture.manifest.expectCrash?.[profile]
        if (crash !== undefined) {
          assert.equal(goldenFile.status, 'crashed', 'the golden crashed')
          assert.equal(run.fileStatus, 'crashed', 'the file crashed here too')
          const wanted = goldenFile.fileError?.message ?? ''
          assert.ok(wanted.includes(crash), `the golden's fileError holds "${crash}"`)
          // The cause line, not a substring: the first line after Jest's header, `<root>` applied.
          // Jest prints the thrown error's class before its message ("ReferenceError: ..."), a
          // name the error here carries apart from its message, so both sides drop a leading one.
          const cause = (line: string): string => line.replace(/^[A-Za-z]*Error: /, '')
          const raised = run.collectionErrors.map((e) =>
            cause(causeText(e.message.replaceAll(run.root, '<root>'))),
          )
          assert.deepEqual(raised, [cause(causeText(wanted))], 'the crash cause')
        } else {
          assert.ok(
            run.tests.length > 0,
            `the file ran at least one test; it raised: ${run.collectionErrors.map((e) => e.message).join(' | ')}`,
          )
          assertTestsMatchGolden(run, goldenFile)
          assertFileOutcome(run, goldenFile)
        }

        const wanted = golden.trace ?? []
        const results = compareObservations(wanted, run.trace)
        if (crash === undefined) assert.ok(results.length > 0, 'the fixture observed a case')
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

test('the corpus is counted: the totals are the corpus', () => {
  assert.ok(fixtures.length > 0, 'the corpus is not empty')
  assert.deepEqual(counted, EXPECTED_COUNTED)
})

/** How many counted cases of `profile` a broken engine gets wrong. */
async function disagreeing(
  profile: FixtureProfile,
  sabotage: 'inert' | 'wrong-values',
): Promise<{ differing: number; total: number }> {
  let differing = 0
  let total = 0
  for (const fixture of fixtures) {
    if (!fixture.manifest.runners.includes(profile)) continue
    if (fixture.manifest.expectCrash?.[profile] !== undefined) continue
    let trace: readonly string[] = []
    const wanted = (await readGolden(fixture.dir, profile)).trace ?? []
    try {
      trace = (await runFixture(fixture, profile, sabotage)).run.trace
    } catch {
      // A fixture that cannot even load under the broken engine disagrees on every case.
    }
    for (const result of compareObservations(wanted, trace)) {
      total++
      if (!result.matches) differing++
    }
  }
  return { differing, total }
}

for (const sabotage of ['inert', 'wrong-values'] as const) {
  for (const profile of ['jest', 'vitest'] as const) {
    const what =
      sabotage === 'inert'
        ? 'a registry that decides nothing is mocked (root mocks included)'
        : 'a registry that keeps its registrations but serves wrong values'
    test(`${what} disagrees with the ${profile} goldens on exactly the pinned cases`, {
      timeout: TIMEOUT_MS * 4,
    }, async () => {
      const { differing, total } = await disagreeing(profile, sabotage)
      assert.ok(total > 0)
      assert.equal(
        differing,
        EXPECTED_DISAGREEING[sabotage][profile],
        `${differing} of ${total} cases disagree`,
      )
    })
  }
}
