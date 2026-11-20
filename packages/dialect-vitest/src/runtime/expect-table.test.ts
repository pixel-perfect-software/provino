// T7.6: the Vitest dialect's matcher table against the real `@vitest/expect` 5.0.5. The real one runs
// in a child (`internal/expect-oracle.ts`, since it defines the matcher slot as it loads); here the
// table runs through `@provino/expect` as the worker builds it. Per case: whether it passes, and on a
// failure the error's name, message and the diff Vitest's runner would print. Then the names: the
// jest-style matchers `JestChaiExpect` defines, the custom matchers, and the asymmetric factories.
// The message corpus (`@provino/harness`'s `expect-corpus.test.ts`) holds the table to Vitest's
// recordings too, frames included.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
} from '@provino/expect'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { CurrentTest } from '@provino/types'
import { vitestPolicy } from '../dialect.ts'
import { withDiff } from './expect-table.ts'
import { type Asymmetric, expectCases, runCase } from './internal/expect-cases.ts'

interface Outcome {
  readonly pass: boolean
  readonly name?: string
  readonly message?: string
  readonly diff?: string | null
}

interface Oracle {
  readonly jestStyle: readonly string[]
  readonly chaiStyleMethods: readonly string[]
  readonly chaiStyleProperties: readonly string[]
  readonly asymmetric: readonly string[]
  readonly asymmetricNot: readonly string[]
  readonly customMatchers: readonly string[]
  readonly results: readonly Outcome[]
}

const child = spawnSync(
  process.execPath,
  [
    '--conditions=provino-source',
    fileURLToPath(new URL('./internal/expect-oracle.ts', import.meta.url)),
  ],
  // The same environment as this process, so both sides pick the same colours.
  { encoding: 'utf8' },
)
assert.equal(child.status, 0, child.stderr)
const oracle = JSON.parse(child.stdout) as Oracle

const policy = resolvePolicy(vitestPolicy).expect
assert.ok(policy.matcherTable)
// No test runs: every assertion counts into the file's state.
const source = createStateSource({ get: () => undefined } as unknown as CurrentTest, {
  nameSeparator: ' > ',
  expand: policy.expand,
  outsideTestCounts: policy.outsideTestCounts,
})
const registry = createMatcherRegistry()
installMatchersSlot(source, registry)
const table = (await createBehaviourLoader().load(policy.matcherTable))()
const expect = createExpect({ policy, table, source, registry })

test('the table has every jest-style matcher Vitest defines, and nothing of its plumbing', () => {
  const plumbing = new Set([
    'withTest',
    'withContext',
    'resolves',
    'rejects',
    'throw',
    'throws',
    'Throw',
  ])
  // sinon-chai's method names (`calledWith`, …) are matchers too, as on Vitest's `expect(x)`.
  const want = [...oracle.jestStyle, ...oracle.chaiStyleMethods]
    .filter((name) => !plumbing.has(name))
    .sort()
  const snapshot = [
    'toMatchSnapshot',
    'toMatchInlineSnapshot',
    'toThrowErrorMatchingSnapshot',
    'toThrowErrorMatchingInlineSnapshot',
    'toMatchFileSnapshot',
  ]
  const got = Object.keys(table.matchers)
    .filter((name) => !oracle.customMatchers.includes(name) && !snapshot.includes(name))
    .sort()
  assert.deepEqual(
    { extra: got.filter((n) => !want.includes(n)), missing: want.filter((n) => !got.includes(n)) },
    { extra: [], missing: [] },
  )
  for (const name of oracle.customMatchers) assert.ok(name in table.matchers, name)
})

test('the asymmetric factories are Vitest`s, on expect and expect.not', () => {
  assert.deepEqual(Object.keys(table.asymmetric).sort(), [...oracle.asymmetric].sort())
  assert.deepEqual(Object.keys(table.asymmetricNot).sort(), [...oracle.asymmetricNot].sort())
})

test('every case passes or fails as in Vitest, with its name, message and diff', () => {
  const cases = expectCases(expect as unknown as Asymmetric, expect.not as unknown as Asymmetric)
  assert.equal(cases.length, oracle.results.length)
  cases.forEach((c, i) => {
    let outcome: Outcome = { pass: true }
    try {
      runCase(expect, c)
    } catch (error) {
      // A Chai chain's error is thrown past the table, so it gets its diff where the run reports it.
      const shaped = withDiff(error as Error) as Error & { diff?: string }
      outcome = {
        pass: false,
        name: shaped.name,
        message: shaped.message,
        diff: shaped.diff ?? null,
      }
    }
    assert.deepEqual(outcome, oracle.results[i], `case ${i}: ${c.not ? 'not.' : ''}${c.matcher}`)
  })
})

test('a failure is Chai`s AssertionError, loaded only then', async () => {
  // A specifier the type checker doesn't resolve: Chai ships no types, and none are a dependency.
  const name = 'chai'
  const chai = (await import(name)) as { AssertionError: new () => Error }
  assert.throws(
    () => expect(1).toBe(2),
    (error: unknown) => error instanceof chai.AssertionError,
  )
})

test('building the table and passing assertions load no Chai; the first failure does', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--conditions=provino-source',
      fileURLToPath(new URL('./internal/lazy-chai.ts', import.meta.url)),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), {
    afterBuild: false,
    afterPassing: false,
    afterFailure: true,
  })
})
