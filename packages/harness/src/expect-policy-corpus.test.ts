// T7.8's corpus check: the six `fixtures/expect/policies` fixtures (F7, P1-P7) run through
// `@provino/core` with `expect` built the way the worker builds it, end-of-test check included.
// Each file runs in a child process (`expect-policy-corpus/child.ts`), since core listens for the
// process's uncaught exceptions and rejections there.
//
// 1. The Jest goldens (4 of the 6 fixtures have one): per test, the status, each error's name,
//    message, matcher and user frame, and the passing count, under the Jest dialect's policy.
// 2. P4-P7 with the global `expect`, under both policies: the bodies of `assertions-concurrent`
//    count per test, so the three tests that meet their count pass and the two that miss it fail,
//    which is `context-expect`'s golden (Vitest's per-test `expect`). Neither runner gets it right
//    with the global `expect`; this is our documented improvement.
// 3. The Vitest goldens' counting outcomes under Vitest's policy: status, and whether the test has
//    an error. The Vitest dialect's runtime is a stub, so its `expect` is built from its
//    `ExpectPolicy` over the Jest matcher table; the text of Vitest's messages is T7.6's.
//
// A difference is allowed only as an explicit pin in `expect-policy-corpus/declared.ts`.
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import { jestExpectPolicy } from '@provino/dialect-jest'
import { vitestPolicy } from '@provino/dialect-vitest'
import { createExpect } from '@provino/expect'
import { resolvePolicy } from '@provino/policy'
import type { ExpectPolicy } from '@provino/types'
import { differences, problems, unseen } from './expect-policy-corpus/compare.ts'
import { JEST_DECLARED, VITEST_DECLARED } from './expect-policy-corpus/declared.ts'
import { type ObservedTests, observed, recorded } from './expect-policy-corpus/observe.ts'
import { SUBSTITUTED } from './expect-policy-corpus/profiles.ts'
import { defaultFixturesRoot, type Fixture, findFixtures, readFixture } from './fixture.ts'

const root = path.join(defaultFixturesRoot(), 'expect', 'policies')
const dirs = await findFixtures(root)
const fixtures = new Map<string, Fixture>()
for (const dir of dirs) fixtures.set(path.basename(dir), await readFixture(dir))

const fixtureNamed = (name: string): Fixture => {
  const found = fixtures.get(name)
  assert.ok(found, `the policy corpus has ${name}`)
  return found
}

test('the policy corpus is there', () => {
  assert.deepEqual([...fixtures.keys()].sort(), [
    'assertions-concurrent',
    'assertions-count',
    'context-expect',
    'removed-aliases',
    'soft-and-poll',
    'unawaited-async',
  ])
})

test('the substituted Vitest policy values are exactly the ones createExpect still refuses', () => {
  const vitest = resolvePolicy(vitestPolicy).expect
  const refused: string[] = []
  for (const key of Object.keys(SUBSTITUTED) as (keyof typeof SUBSTITUTED)[]) {
    assert.notDeepEqual(SUBSTITUTED[key], vitest[key], `${key} is Vitest's own, no stand-in needed`)
    try {
      createExpect({
        policy: { ...jestExpectPolicy, [key]: vitest[key] } as ExpectPolicy,
        table: undefined as never,
        source: undefined as never,
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'EXPECT_NOT_IMPLEMENTED') throw error
      refused.push(key)
    }
  }
  assert.deepEqual(refused.sort(), ['equality', 'errorShape'])
})

describe('the Jest goldens', () => {
  const seen = new Set<string>()
  for (const name of [
    'assertions-concurrent',
    'assertions-count',
    'removed-aliases',
    'unawaited-async',
  ]) {
    test(name, async () => {
      const fixture = fixtureNamed(name)
      const found = differences(
        await recorded(fixture, 'jest'),
        await observed(fixture, 'jest'),
        'full',
      )
      assert.deepEqual(problems(`${name} (jest)`, found, JEST_DECLARED, seen), [])
    })
  }
  test('every declared difference was used', () => {
    assert.deepEqual(unseen(JEST_DECLARED, seen), [])
  })
})

/** The status of each test by its own title (the last one), which the two fixtures share. */
const statusByTitle = (tests: ObservedTests): Record<string, string> =>
  Object.fromEntries(
    [...tests].map(([key, test]) => [key.split(' › ').at(-1)?.replace(/#\d+$/, ''), test.status]),
  )

describe('P4-P7: the global expect counts per test, under both policies', () => {
  for (const profile of ['jest', 'vitest'] as const) {
    test(profile, async () => {
      // `context-expect` holds the same five bodies, counted with Vitest's per-test `expect`.
      const want = statusByTitle(await recorded(fixtureNamed('context-expect'), 'vitest'))
      const got = statusByTitle(await observed(fixtureNamed('assertions-concurrent'), profile))
      assert.deepEqual(got, want)
      assert.deepEqual(Object.values(got).sort(), [
        'failed',
        'failed',
        'passed',
        'passed',
        'passed',
      ])
    })
  }
})

describe('the Vitest goldens, as counting outcomes', () => {
  const seen = new Set<string>()
  for (const name of ['assertions-count', 'removed-aliases', 'soft-and-poll', 'unawaited-async']) {
    test(name, async () => {
      const fixture = fixtureNamed(name)
      const found = differences(
        await recorded(fixture, 'vitest'),
        await observed(fixture, 'vitest'),
        'outcome',
      )
      assert.deepEqual(problems(`${name} (vitest)`, found, VITEST_DECLARED, seen), [])
    })
  }
  test('every declared difference was used', () => {
    assert.deepEqual(unseen(VITEST_DECLARED, seen), [])
  })
})

describe('the corpus catches a wrong policy value', () => {
  for (const [name, profile, flip] of [
    ['unawaited-async', 'vitest', 'unawaited-ignore'],
    ['unawaited-async', 'jest', 'unawaited-fail'],
    ['soft-and-poll', 'vitest', 'soft-off'],
    ['soft-and-poll', 'vitest', 'poll-off'],
    ['soft-and-poll', 'vitest', 'poll-quiet-timeout'],
  ] as const) {
    test(`${name} under ${profile} with ${flip}`, async () => {
      const fixture = fixtureNamed(name)
      const found = differences(
        await recorded(fixture, profile),
        await observed(fixture, profile, flip),
        'outcome',
      )
      assert.ok(found.size > 0, `${flip} changes no outcome`)
    })
  }
})
