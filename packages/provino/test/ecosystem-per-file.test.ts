// D132 through `provino jest`, held to the run Jest 30.5.2 recorded for it
// (`ecosystem/per-file-registry`): a package evaluated per file because it imports one that reads
// the environment's `document` at load (D129) registers an entry into a module-level registry it
// reaches through a re-export, so the registry is evaluated per file with it, and the entry is
// registered once in each of three files on one worker. A dependency it shares with a package
// that reads nothing per file (core-lib under plain-widget) is per file too, as Jest's is: a learned
// package's whole closure is per file, so a cold worker's set is a warm one's (D132 as amended).
// B23f (D149 as amended): a package whose load adds or replaces a key of the global is evaluated
// per file from the next file on (`module.reevaluatePatchingExternals`), since the environment's
// restore takes the key away after each file and a shared copy never writes it again
// (`ecosystem/load-time-global`, and msw's interceptors in `ecosystem/msw-setup-file`).
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { assertMatchesGolden, linkEnvironments, provinoOn, WORK } from './recorded-run.ts'

/** A directory of this file's own under `.work/`, whose `node_modules` holds the environments. */
const PARENT = join(WORK, 'ecosystem-per-file')

before(() => linkEnvironments(PARENT))
after(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe('packages evaluated per file take what only they import (D132), against Jest 30.5.2', () => {
  it('ecosystem/per-file-registry: one registration per file, and core-lib per file as in Jest', async () => {
    const id = 'ecosystem/per-file-registry'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it('ecosystem/per-file-registry-cycle: a registry whose files import each other is per file with the plugin', async () => {
    const id = 'ecosystem/per-file-registry-cycle'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })
})

describe('packages that write the global as they load are per file (B23f), against Jest 30.5.2', () => {
  it('ecosystem/load-time-global: the second file sees the key the package added and the one it replaced', async () => {
    const id = 'ecosystem/load-time-global'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it('ecosystem/msw-setup-file: a setup file’s server intercepts in both files, and passes through', async () => {
    const id = 'ecosystem/msw-setup-file'
    // Before B23f the second file's unhandled fetch looped for good; the deadline ends it fast.
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT, deadlineMs: 60_000 }))
  })
})
