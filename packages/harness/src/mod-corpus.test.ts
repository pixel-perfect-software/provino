// The module-mock check (T4.7, B13b; T2.5 + T4.8 on the real loader, B13c): every recorded `mod-*`
// fixture, run through `@provino/loader` (real resolver, real hoister, real module-mock registry)
// and `@provino/core`, must observe what the real runner recorded: each case's line equals the
// golden's trace line, in the golden's order, every test the golden lists ran with the golden's
// status, the file ended with the golden's status and errors where the golden has them, and a
// golden that crashed crashed here for the same cause. The bar is every case except the declared
// divergences below, each pinned to the exact line we may give, which fail the check the day they
// stop differing or differ otherwise. Two broken engines must disagree with the goldens on an exact
// number of cases, so the check cannot pass by observing nothing. Each Jest fixture also runs end to
// end through `provino/node`'s `run()` and a forked worker, against the same golden (the `e2e`
// block below).
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
import { runModEndToEnd } from './mod-corpus/run-e2e.ts'
import { type ModProfile, runModFile } from './mod-corpus/run-mod.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { pairLabel } from './test-support.ts'

/** The Jest and Vitest profiles the loader runs under. */
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
  // Jest 30.5.2 runs a test file in a vm script, and an `import()` that its transformer leaves
  // as written (babel-jest with the CommonJS plugin, as this fixture records it) throws without
  // `--experimental-vm-modules`. We load it, as Vitest does (B13c Gap 6); a Jest-green suite never
  // has this, so nothing green turns red (D7).
  'mocking/mod-dynamic-only (jest) import() from a file with no other module syntax loads the module and its imports':
    {
      divergence: 'DV18',
      line: '{"id":"import() from a file with no other module syntax loads the module and its imports","value":{"value":"base-target","described":"default of base-target"}}',
    },
  'mocking/mod-dynamic-only (jest) a second import() of the same module gets the same instance': {
    divergence: 'DV18',
    line: '{"id":"a second import() of the same module gets the same instance","value":true}',
  },
}

/** The counted cases the corpus has under each profile, exactly. */
const EXPECTED_COUNTED: Readonly<Partial<Record<FixtureProfile, number>>> = {
  // B13b's 114 and 102, plus B13c's fixtures: `mod-require-esm-helper` 3, `mod-automock-scratch` 4,
  // `mod-cjs-lazy` 4 and `mod-dynamic-only` 2 under Jest, and `mod-dynamic-only` 2 under Vitest.
  jest: 127,
  vitest: 104,
}

/**
 * How many counted cases each broken engine gets wrong, exactly (of `EXPECTED_COUNTED`, crashed
 * goldens aside). A fixture that stopped observing, or an engine change that makes a broken
 * registry agree with the goldens, moves these.
 */
const EXPECTED_DISAGREEING: Readonly<
  Record<'inert' | 'wrong-values', Readonly<Partial<Record<FixtureProfile, number>>>>
> = {
  // B13b's counts plus what B13c's fixtures add under Jest (no new Vitest case mocks anything):
  // inert +10 (the helper's mock 3, the automock 3, the virtual mock 2, and the 2 declared
  // `import()` cases, which differ from the golden under any engine), wrong-values +8 (3, 1, 2, 2).
  inert: { jest: 92, vitest: 73 },
  'wrong-values': { jest: 80, vitest: 72 },
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
          assert.equal(run.tests.length, 0, 'a crashed file ran no test')
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

// ---- end to end: T4.8 through the worker (S4) ----

/**
 * The Jest fixtures that run in-process only, because their `jestConfig` names something a
 * Provino config can't carry yet: neutral `roots` and `unmockedModulePathPatterns` are B14c's.
 * Exactly the Jest fixtures with a `jestConfig`, so the list can't grow quietly.
 */
const IN_PROCESS_ONLY: Readonly<Record<string, string>> = {
  'mocking/mod-roots-multiple': 'jestConfig.roots (B14c)',
  'mocking/mod-unmocked-patterns': 'jestConfig.unmockedModulePathPatterns (B14c)',
}

/** A forked worker boots per fixture, so the deadline is the in-process one, doubled. */
const E2E_TIMEOUT_MS = TIMEOUT_MS * 2
/** How long before the test's deadline its run is aborted, so the abort and cleanup can finish. */
const E2E_ABORT_MARGIN_MS = 5_000

const jestFixtures = fixtures.filter((fixture) => fixture.manifest.runners.includes('jest'))
const e2eSeen = new Set<string>()
let e2eCounted = 0

test('e2e: the fixtures left in-process are exactly the Jest ones with a jestConfig', () => {
  assert.deepEqual(
    jestFixtures
      .filter((fixture) => fixture.manifest.jestConfig !== undefined)
      .map((fixture) => fixture.id)
      .sort(),
    Object.keys(IN_PROCESS_ONLY).sort(),
  )
})

describe('e2e: each Jest mod fixture through provino/node run() and a forked worker', () => {
  for (const fixture of jestFixtures) {
    if (Object.hasOwn(IN_PROCESS_ONLY, fixture.id)) continue
    test(fixture.id, { timeout: E2E_TIMEOUT_MS }, async () => {
      // The run stops (its worker killed, the trace variable put back) before the test's deadline.
      const signal = AbortSignal.timeout(E2E_TIMEOUT_MS - E2E_ABORT_MARGIN_MS)
      const files = testFilesFor(fixture.files, 'jest')
      const [testFile] = files
      assert.ok(testFile !== undefined && files.length === 1, 'one test file')
      const golden = await readGolden(fixture.dir, 'jest')
      const [goldenFile] = golden.files
      assert.ok(goldenFile !== undefined && golden.files.length === 1, 'one golden file')
      const run = await runModEndToEnd(fixture, testFile, signal)
      const [ranFile] = run.normalized.files
      assert.ok(
        ranFile !== undefined && run.normalized.files.length === 1,
        `one file ran (exit ${run.exitCode}): ${run.stderr}`,
      )

      const crash = fixture.manifest.expectCrash?.jest
      if (crash !== undefined) {
        assert.equal(goldenFile.status, 'crashed', 'the golden crashed')
        assert.equal(ranFile.status, 'crashed', 'the file crashed here too')
        assert.equal(ranFile.tests.length, 0, 'a crashed file ran no test')
        assert.equal(run.exitCode, 1, 'the exit code')
        const cause = (line: string): string => line.replace(/^[A-Za-z]*Error: /, '')
        const raised = cause(
          causeText((ranFile.fileError?.message ?? '').replaceAll(run.root, '<root>')),
        )
        assert.equal(
          raised,
          cause(causeText(goldenFile.fileError?.message ?? '')),
          'the crash cause',
        )
      } else {
        assert.deepEqual(
          ranFile.tests.map((t) => ({
            path: t.id.path,
            dupIndex: t.id.dupIndex,
            status: t.status,
          })),
          goldenFile.tests.map((t) => ({
            path: t.id.path,
            dupIndex: t.id.dupIndex,
            status: t.status,
          })),
          'tests: title path, dupIndex and status',
        )
        assert.equal(ranFile.status, goldenFile.status, 'file status')
        assert.equal(run.exitCode, goldenFile.status === 'passed' ? 0 : 1, 'the exit code')
      }

      const wanted = golden.trace ?? []
      const results = compareObservations(wanted, run.trace)
      if (crash === undefined) assert.ok(results.length > 0, 'the fixture observed a case')
      assert.ok(sameOrder(wanted, run.trace), 'the cases were observed in the golden order')
      e2eCounted += results.length
      assert.deepEqual(declaredProblems(pairLabel(fixture, 'jest'), results, DECLARED, e2eSeen), [])
    })
  }
})

test('e2e: every Jest case outside the in-process-only fixtures ran end to end', async () => {
  // The exact Jest total, less the cases of the fixtures left in-process (counted in-process).
  let inProcessCases = 0
  for (const fixture of jestFixtures) {
    if (!Object.hasOwn(IN_PROCESS_ONLY, fixture.id)) continue
    inProcessCases += (await readGolden(fixture.dir, 'jest')).trace?.length ?? 0
  }
  assert.ok(inProcessCases > 0)
  assert.equal(e2eCounted + inProcessCases, EXPECTED_COUNTED.jest)
  assert.deepEqual(unseenDeclared(jestOnly(DECLARED), e2eSeen), [])
})

/** The declared cases of the Jest profile: the ones the end-to-end runs must meet. */
function jestOnly(
  declared: Readonly<Record<string, Declared>>,
): Readonly<Record<string, Declared>> {
  return Object.fromEntries(Object.entries(declared).filter(([key]) => key.includes(' (jest) ')))
}

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
    const wanted = (await readGolden(fixture.dir, profile)).trace ?? []
    // Nothing is caught: a file that fails to load under the broken engine is a collection error
    // in the run, which disagrees on its cases by itself, so a throw here is the harness's own.
    const { trace } = (await runFixture(fixture, profile, sabotage)).run
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
      // Every counted case was compared, and the broken engine observed no case of its own (a
      // crashed golden observes none, so leaving those files out leaves the total whole).
      assert.equal(total, EXPECTED_COUNTED[profile], 'every counted case was compared')
      assert.equal(
        differing,
        EXPECTED_DISAGREEING[sabotage][profile],
        `${differing} of ${total} cases disagree`,
      )
    })
  }
}
