// The resolution conditions of a module's edges through `provino jest`, each fixture held to the
// run Jest 30.5.2 recorded for it (`env/conditions-import-*`): jest-runtime resolves every edge of
// a module it runs as CommonJS (an `import` Babel turned into `require` too) with its CJS
// conditions, and every edge of a module it runs as an ES module with its ESM ones
// (`module.edgeResolveKind: 'importer-format'`), `module-sync` among them
// (`module.moduleSyncCondition`; its `require` half depends on the Node version and is held by the
// loader's `edge-kind.test.ts`). Each test's title names the entry it got.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { assertMatchesGolden, linkEnvironments, provinoOn, WORK } from './recorded-run.ts'

/** The projects' parent, whose `node_modules` holds the environment packages the harness installs. */
const PARENT = join(WORK, 'jest-conditions')

const FIXTURE_IDS = [
  ['env/conditions-import-node', 'a CommonJS-run file and its helper import under `require`'],
  ['env/conditions-import-jsdom', 'the same under jsdom: its `browser` and the CJS conditions'],
  ['env/conditions-import-custom', '`customExportConditions` with the CJS conditions'],
  ['env/conditions-import-esm', 'an ES-module-run file and its helper import under `import`'],
  ['env/conditions-import-module-sync', "an ES module's edges take a `module-sync` entry"],
] as const

before(() => linkEnvironments(PARENT))
after(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe("a module's edges resolve with Jest's conditions for its format, against Jest 30.5.2", () => {
  for (const [id, title] of FIXTURE_IDS) {
    it(`${id}: ${title}`, async () => {
      assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
    })
  }
})
