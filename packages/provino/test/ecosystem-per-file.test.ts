// D132 through `provino jest`, held to the run Jest 30.5.2 recorded for it
// (`ecosystem/per-file-registry`): a package evaluated per file because it imports one that reads
// the environment's `document` at load (D129) registers an entry into a module-level registry it
// reaches through a re-export, so the registry is evaluated per file with it, and the entry is
// registered once in each of three files on one worker. A dependency it shares with a package
// that reads nothing per file stays shared per worker: the one declared difference.
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
  it('ecosystem/per-file-registry: one registration per file, one shared core-lib per worker', async () => {
    const id = 'ecosystem/per-file-registry'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }), {
      declared: {
        'file:core-lib-loads.txt': {
          golden: 'evaluated\nevaluated\nevaluated\n',
          provino: 'evaluated\n',
          reason:
            'Jest evaluates every module per file; core-lib is imported by a package that reads nothing per file too, so it stays shared per worker (D132)',
        },
      },
    })
  })
})
