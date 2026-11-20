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
import { isDeepStrictEqual } from 'node:util'
import { withDiff } from './expect-table.ts'
import { type Asymmetric, expectCases, runCase, type Side } from './internal/expect-cases.ts'
import { setUpVitestExpect } from './internal/expect-setup.ts'

interface Outcome {
  readonly pass: boolean
  readonly name?: string
  readonly message?: string
  readonly diff?: string | null
  readonly cause?: string | null
}

interface Oracle {
  readonly jestStyle: readonly string[]
  readonly chaiStyleMethods: readonly string[]
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

// No test runs: every assertion counts into the file's state. The table is the one
// `vitestPolicy.expect.matcherTable`'s ref loads, through the behaviour loader, as the worker loads it.
const { expect, table } = await setUpVitestExpect()

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

test('every case passes or fails as in Vitest, with its name, message and diff', async () => {
  const cases = expectCases(expect as unknown as Asymmetric, expect.not as unknown as Asymmetric)
  assert.equal(cases.length, oracle.results.length)
  const side: Side = {
    expect: expect as unknown as Side['expect'],
    extend: (matchers) => expect.extend(matchers as never),
  }
  const differ: string[] = []
  for (const [i, c] of cases.entries()) {
    let outcome: Outcome = { pass: true }
    try {
      await runCase(side, c)
    } catch (error) {
      // A Chai chain's error is thrown past the table, so it gets its diff where the run reports it.
      const shaped = withDiff(error as Error) as Error & { diff?: string }
      outcome = {
        pass: false,
        name: shaped.name,
        message: shaped.message,
        diff: shaped.diff ?? null,
        cause: shaped.cause === undefined ? null : String(shaped.cause),
      }
    }
    if (!isDeepStrictEqual(outcome, oracle.results[i])) {
      differ.push(
        `case ${i}: ${c.not ? 'not.' : ''}${c.matcher}\n  want ${JSON.stringify(oracle.results[i])}\n  got  ${JSON.stringify(outcome)}`,
      )
    }
  }
  assert.deepEqual(differ, [])
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

test('building the table and passing assertions (toHaveBeenCalled too) load no Chai; the first failure does', () => {
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
    afterCalled: false,
    afterFailure: true,
  })
})
