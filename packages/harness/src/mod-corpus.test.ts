// B13b's module-mock check (T4.7): every recorded `mod-*` fixture, run through the fake loader
// (real resolver, real hoister, real module-mock registry) and `@provino/core`, must observe what
// the real runner recorded: each case's line equals the golden's trace line, in the golden's order,
// every test the golden lists ran with the golden's status, and a golden that crashed crashed here
// with the same text. The bar is every case except the declared divergences below, each pinned to
// the exact line we may give, which fail the check the day they stop differing or differ otherwise.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
import { type Golden, goldenPath } from './golden.ts'
import { compareObservations, sameOrder } from './mock-corpus/compare.ts'
import { mockPolicyFor, vitestHoistPolicy, vitestModulePolicy } from './mock-corpus/profiles.ts'
import { type ModProfile, runModFile } from './mod-corpus/run-mod.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { pairLabel } from './test-support.ts'

/** The Jest and Vitest profiles the fake loader runs under. */
const jestModule = resolvePolicy(jestPolicy).module
const PROFILES: Readonly<Partial<Record<FixtureProfile, ModProfile>>> = {
  jest: {
    facade: 'jest',
    core: corePolicyFor.jest,
    mock: mockPolicyFor.jest,
    module: jestModule,
    hoist: jestHoistPolicy,
    babelExports: true,
  },
  vitest: {
    facade: 'vi',
    core: corePolicyFor.vitest,
    mock: mockPolicyFor.vitest,
    module: vitestModulePolicy,
    hoist: vitestHoistPolicy,
    babelExports: false,
  },
}

/** A declared divergence: the DIVERGENCES row, and the exact line we may give for the case. */
interface Declared {
  readonly divergence: string
  readonly line: string
}

/**
 * The cases whose observation differs from the golden, by `fixture (profile) case`. The check fails
 * on a difference not listed here, on a listed case that now matches, and on a listed case whose
 * line is not the one pinned here.
 */
const DECLARED: Readonly<Record<string, Declared>> = {}

/** The counted cases the corpus has under each profile, exactly. */
const EXPECTED_COUNTED: Readonly<Partial<Record<FixtureProfile, number>>> = {
  jest: 53,
  vitest: 46,
}

/** Per-file deadline: a hang is a real flaw, not something to retry. */
const TIMEOUT_MS = 30_000

const root = path.join(defaultFixturesRoot(), 'mocking')
const dirs = await findFixtures(root)
const fixtures: Fixture[] = (await Promise.all(dirs.map((dir) => readFixture(dir)))).filter(
  (fixture) => path.basename(fixture.dir).startsWith('mod-'),
)

const counted: Partial<Record<FixtureProfile, number>> = {}
const seen = new Set<string>()

async function runFixture(fixture: Fixture, profile: FixtureProfile, neverMock = false) {
  const modProfile = PROFILES[profile]
  assert.ok(modProfile !== undefined, `no mod profile for ${profile}`)
  const files = testFilesFor(fixture.files, profile)
  const [testFile] = files
  assert.ok(testFile !== undefined && files.length === 1, 'one test file per profile')
  const golden = JSON.parse(await readFile(goldenPath(fixture.dir, profile), 'utf8')) as Golden
  const run = await runModFile(fixture, testFile, modProfile, { neverMock })
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
          const messages = run.collectionErrors.map((e) => e.message).join('\n')
          assert.ok(
            messages.includes(crash),
            `the crash text "${crash}" is in what we raised:\n${messages}`,
          )
        } else {
          assert.ok(
            run.tests.length > 0,
            `the file ran at least one test; it raised: ${run.collectionErrors.map((e) => e.message).join(' | ')}`,
          )
          assert.deepEqual(
            run.tests.map((t) => ({ path: t.path, dupIndex: t.dupIndex, status: t.status })),
            goldenFile.tests.map((t) => ({
              path: t.id.path,
              dupIndex: t.id.dupIndex,
              status: t.status,
            })),
            'tests: title path, dupIndex and status',
          )
        }

        const wanted = golden.trace ?? []
        const results = compareObservations(wanted, run.trace)
        if (crash === undefined) assert.ok(results.length > 0, 'the fixture observed a case')
        assert.ok(sameOrder(wanted, run.trace), 'the cases were observed in the golden order')
        counted[profile] = (counted[profile] ?? 0) + results.length
        const problems: string[] = []
        for (const result of results) {
          const key = `${label} ${result.id}`
          seen.add(key)
          const declared = DECLARED[key]
          if (declared === undefined) {
            if (!result.matches) {
              problems.push(
                `${key} differs and is not declared\n  want ${result.want}\n  got  ${result.got}`,
              )
            }
          } else if (result.matches) {
            problems.push(`${key} is declared (${declared.divergence}) and now matches the golden`)
          } else if (result.got !== declared.line) {
            problems.push(
              `${key} is declared (${declared.divergence}) but gave another line\n  pinned ${declared.line}\n  got    ${result.got}`,
            )
          }
        }
        assert.deepEqual(problems, [])
      })
    }
  })
}

test('every declared case is a case of the corpus', () => {
  const unknown = Object.keys(DECLARED).filter((key) => !seen.has(key))
  assert.deepEqual(unknown, [])
})

test('the corpus is counted: the totals are the corpus', () => {
  assert.ok(fixtures.length > 0, 'the corpus is not empty')
  assert.deepEqual(counted, EXPECTED_COUNTED)
})

test('a registry that never mocks disagrees with the goldens on many cases', {
  timeout: TIMEOUT_MS * 4,
}, async () => {
  const profile: FixtureProfile = 'jest'
  let differing = 0
  let total = 0
  for (const fixture of fixtures) {
    if (!fixture.manifest.runners.includes(profile)) continue
    if (fixture.manifest.expectCrash?.[profile] !== undefined) continue
    let trace: readonly string[]
    let wanted: readonly string[]
    try {
      const { golden, run } = await runFixture(fixture, profile, true)
      wanted = golden.trace ?? []
      trace = run.trace
    } catch {
      // A fixture that cannot even load without its mocks disagrees with the golden too.
      const { golden } = await runFixture(fixture, profile).catch(() => ({ golden: null }))
      wanted = golden?.trace ?? []
      trace = []
    }
    for (const result of compareObservations(wanted, trace)) {
      total++
      if (!result.matches) differing++
    }
  }
  assert.ok(total > 0)
  assert.ok(differing >= 15, `only ${differing} of ${total} cases disagree without module mocking`)
})
