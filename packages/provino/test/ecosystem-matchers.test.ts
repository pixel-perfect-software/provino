// B23e Phase 2b (T11.11, T7.16): the matcher, mock and network packages a Jest project loads from
// its own node_modules, run through `provino jest` and held to what Jest 30.5.2 recorded for the
// same project (`ecosystem/*`): the exit code, the kept stderr lines and the whole results file.
// Each fixture has two test files under `-w 1`, so the second file runs in a worker that already
// loaded the package for the first.
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FIXTURES as FIXTURE_ROOT } from './recorded.ts'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'

const FIXTURES = [
  ['ecosystem/identity-obj-proxy', "a CSS mapper and Babel's interop over __esModule: false"],
  ['ecosystem/expect-type', 'expect-type loads and its calls do nothing'],
] as const

/**
 * Recorded, and left out until the work named here lands. Phase 2d (D127): under isolation
 * `registry` a package in node_modules loads once per worker, so the second file sees the first
 * file's instance. Each one's second file, run alone, gives what Jest gave.
 * - `jest-extended-all`: `setupFilesAfterEnv: ["jest-extended/all"]` extends `expect` once; in
 *   `values.test.ts` every matcher is `expect(...).toBeOneOf is not a function`.
 * - `jest-when`: its module registry of when-mocks carries `calls.test.ts`'s uncalled mock into
 *   `verify.test.ts` (`2 not called` where Jest has `1`).
 * - `jest-fetch-mock`: the `jest.fn`s `enableMocks()` made are the first file's, so the second
 *   file's `resetMocks` misses them (an implementation where Jest has none; 3 calls for 1).
 * - `msw-node`: `second.test.ts`'s fetches are no longer intercepted after `handlers.test.ts`
 *   closed its server, and the run hangs.
 *
 * Stopped, a loader gap (not 2d: both files fail): `jest-mock-extended`'s own
 * `require('@jest/globals')` runs in a shared external, so it reaches the real package, which
 * throws `Do not import \`@jest/globals\` outside of the Jest test environment`.
 */
const LEFT_OUT: readonly string[] = [
  'ecosystem/jest-extended-all',
  'ecosystem/jest-when',
  'ecosystem/jest-fetch-mock',
  'ecosystem/msw-node',
  'ecosystem/jest-mock-extended',
]

/** The seven fixtures Phase 2b records (other phases add `ecosystem/*` fixtures of their own). */
const PHASE_2B: ReadonlySet<string> = new Set([
  'ecosystem/jest-extended-all',
  'ecosystem/jest-mock-extended',
  'ecosystem/jest-when',
  'ecosystem/jest-fetch-mock',
  'ecosystem/msw-node',
  'ecosystem/identity-obj-proxy',
  'ecosystem/expect-type',
])

describe('ecosystem matchers, mocks and network, against Jest 30.5.2', () => {
  it('runs every Phase 2b fixture or names why it does not', async () => {
    const phase2b = (await readdir(join(FIXTURE_ROOT, 'ecosystem')))
      .map((name) => `ecosystem/${name}`)
      .filter((id) => PHASE_2B.has(id))
    assert.deepEqual([...FIXTURES.map(([id]) => id), ...LEFT_OUT].toSorted(), phase2b.toSorted())
  })

  for (const [id, title] of FIXTURES) {
    it(`${id}: ${title}`, async () => {
      assertMatchesGolden(id, await provinoOn(id))
    })
  }
})
