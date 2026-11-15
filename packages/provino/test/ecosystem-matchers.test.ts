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
  // Phase 2d (D127, P42): a package that reads `expect` or `jest` while it first loads in a
  // worker is evaluated again for each later file (`module.reevaluateHookingExternals`).
  ['ecosystem/jest-extended-all', "jest-extended/all's expect.extend, in both files"],
  ['ecosystem/jest-fetch-mock', "enableMocks()'s jest.fn, the second file's own"],
  // A shared package's own `require('@jest/globals')` gets the served module.
  ['ecosystem/jest-mock-extended', 'mock<T>() and calledWith over the served @jest/globals'],
] as const

/**
 * Recorded, and left out until the work named here lands.
 * - `jest-when`: Jest's `AssertionError` text. `verifyAllWhenMocksCalled` throws Node's
 *   `assert.equal` error, which Jest prints as `assert.equal(received, expected)` with `Expected
 *   value to be equal to:`, `Received:`, `Message:` and a `Difference:`, where Provino prints
 *   `AssertionError [ERR_ASSERTION]: Failed verifyAllWhenMocksCalled: 1 not called:`. The count is
 *   Jest's since Phase 2d (`when` is evaluated per file); the text is `task/B23e-node-assert`'s.
 * - `msw-node`: `second.test.ts`'s fetches are no longer intercepted after `handlers.test.ts`
 *   closed its server, and the run hangs. msw reads no per-file global while it loads (the node
 *   environment installs none it reads), so Phase 2d's trigger never fires for it: what the second
 *   file needs is a fresh copy of its module state, which only evaluating it per file whatever it
 *   reads would give.
 */
const LEFT_OUT: readonly string[] = ['ecosystem/jest-when', 'ecosystem/msw-node']

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
