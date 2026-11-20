// T7.7's check: the `fixtures/expect/equality` (spike C's 31 cases) and `fixtures/expect/realm`
// (its 18 cross-realm cases) goldens, against Provino's engine under each dialect's own `expect`
// slice: Jest's matcher table under the Jest policy, Vitest's (T7.6) under the Vitest policy.
//   - Each profile's 31 equality verdicts are its golden's; the runners disagree on the 5 Error
//     and invalid-Date cases the two equality rules decide.
//   - The realm cases are all equal in the other realm, and are all judged so under both
//     dialects. Vitest's own runner fails 10 of them (its `@vitest/expect` reads `constructor` and
//     `instanceof`); the vendored copy is realm-safe (`dialect-vitest`'s vendor UPSTREAM.md, patch
//     10), the improvement D7 asks for, declared below.
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import { jestExpectPolicy } from '@provino/dialect-jest'
import { vitestPolicy } from '@provino/dialect-vitest'
import { resolvePolicy } from '@provino/policy'
import type { ExpectPolicy } from '@provino/types'
import { runExpectFile } from './expect-corpus/run-expect.ts'
import { defaultFixturesRoot, type Fixture, readFixture, testFilesFor } from './fixture.ts'
import { readGolden } from './golden.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'

const VITEST_EQUALITY = resolvePolicy(vitestPolicy).expect.equality
assert.deepEqual(
  { ...VITEST_EQUALITY },
  { errors: 'assert', invalidDate: 'equal' },
  "the Vitest dialect's equality policy",
)

const policies: Readonly<Record<'jest' | 'vitest', ExpectPolicy>> = {
  jest: jestExpectPolicy,
  // Vitest's own slice: its matcher table (T7.6) and equality rules (T7.7).
  vitest: resolvePolicy(vitestPolicy).expect,
}

/**
 * The realm cases Vitest's own runner fails and Provino passes under both policies: the
 * constructor and `instanceof` reads of `@vitest/expect` 5.0.5 (Track 7 F4). Pinned by number.
 */
const VITEST_REALM_BUGS = ['03', '04', '08', '09', '10', '11', '12', '13', '14', '15']

const EQUALITY = 31
const REALM = 18

async function verdicts(
  fixture: Fixture,
  profile: 'jest' | 'vitest',
  query: string,
): Promise<Map<string, string>> {
  const [file] = testFilesFor(fixture.files, profile)
  assert.ok(file !== undefined, 'one test file')
  const tests = await runExpectFile(
    path.join(fixture.dir, file),
    fixture.dir,
    corePolicyFor[profile],
    {
      expectPolicy: policies[profile],
      importQuery: query,
      ...(profile === 'vitest' ? { facade: 'vi' as const } : {}),
    },
  )
  return new Map(tests.map((t) => [t.path.at(-1)?.slice(0, 2) ?? '', t.status]))
}

async function recorded(
  fixture: Fixture,
  profile: 'jest' | 'vitest',
): Promise<Map<string, string>> {
  const golden = await readGolden(fixture.dir, profile)
  return new Map(
    golden.files.flatMap((f) =>
      f.tests.map((t) => [t.id.path.at(-1)?.slice(0, 2) ?? '', t.status]),
    ),
  )
}

const equality = await readFixture(path.join(defaultFixturesRoot(), 'expect', 'equality'))
const realm = await readFixture(path.join(defaultFixturesRoot(), 'expect', 'realm'))

describe('equality (spike C, 31 cases)', () => {
  for (const profile of ['jest', 'vitest'] as const) {
    test(`${profile}: every verdict is the ${profile} golden's`, async () => {
      const ran = await verdicts(equality, profile, `equality-${profile}`)
      const wanted = await recorded(equality, profile)
      assert.equal(wanted.size, EQUALITY)
      assert.deepEqual([...ran], [...wanted])
    })
  }

  test('the runners disagree on exactly the five Error and invalid Date cases', async () => {
    const jest = await recorded(equality, 'jest')
    const vitest = await recorded(equality, 'vitest')
    const differ = [...jest].filter(([id, status]) => vitest.get(id) !== status).map(([id]) => id)
    assert.deepEqual(differ, ['27', '28', '29', '30', '31'])
  })
})

describe('realm (spike C, 18 cases)', () => {
  test('jest: 18 of 18, the golden`s', async () => {
    const ran = await verdicts(realm, 'jest', 'realm-jest')
    const wanted = await recorded(realm, 'jest')
    assert.equal(wanted.size, REALM)
    assert.deepEqual([...ran], [...wanted])
    assert.ok([...ran.values()].every((status) => status === 'passed'))
  })

  test('vitest: 18 of 18 pass, where Vitest`s own runner fails the ones listed', async () => {
    const ran = await verdicts(realm, 'vitest', 'realm-vitest')
    assert.equal(ran.size, REALM)
    assert.ok([...ran.values()].every((status) => status === 'passed'))
    const wanted = await recorded(realm, 'vitest')
    const failed = [...wanted].filter(([, status]) => status !== 'passed').map(([id]) => id)
    assert.deepEqual(failed, VITEST_REALM_BUGS)
  })
})
