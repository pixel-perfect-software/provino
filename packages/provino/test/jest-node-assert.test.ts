// A test that fails with a `node:assert` AssertionError prints jest-circus's own text under Jest
// (`formatNodeAssertErrors`: `assert.equal(received, expected)`, `Expected value to be equal to:`,
// the diff), not Node's `AssertionError [ERR_ASSERTION]: ...`. `cli/node-assert` records Jest
// 30.5.2's stderr and results file for every `assert` form; `provino jest` must print the same.
import { describe, it } from 'node:test'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'

describe('provino jest formats node:assert failures as Jest 30.5.2 does', () => {
  it('cli/node-assert: the exit code, the failure blocks and every failureMessages entry', async () => {
    const run = await provinoOn('cli/node-assert')
    assertMatchesGolden('cli/node-assert', run)
  })
})
