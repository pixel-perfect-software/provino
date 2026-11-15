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

  it('cli/node-assert-expand: --expand prints the whole diff, as state.expand does', async () => {
    const run = await provinoOn('cli/node-assert-expand')
    assertMatchesGolden('cli/node-assert-expand', run)
  })

  it('cli/node-assert-unhandled: an unhandled rejection the running test owns is shaped', async () => {
    const run = await provinoOn('cli/node-assert-unhandled')
    assertMatchesGolden('cli/node-assert-unhandled', run)
  })
})
