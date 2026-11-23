// A patch the process's own code makes to Node's CommonJS loader never reaches a test file's
// modules, as under Jest 30.5.2, whose jest-runtime loads them itself (`module.nativeLoadPatches`).
// Next.js patches it (its require hook, which next/jest's config and transformer load in the process
// that runs the tests); here a `globalSetup` does, in band: an installed package's own `require`s,
// which Provino has Node load, still find what Jest's runtime finds.
import { describe, it } from 'provino'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'

describe('provino jest: a patch of Node’s loader made outside the test files', () => {
  it('cli/module-patch-outer-realm: an installed package’s requires meet none of it', async () => {
    const id = 'cli/module-patch-outer-realm'
    assertMatchesGolden(id, await provinoOn(id))
  })
})
