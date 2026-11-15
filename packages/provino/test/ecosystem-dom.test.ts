// B23e Phase 2a: the ecosystem's DOM packages through `provino jest`, each held to the run Jest
// 30.5.2 recorded for it (`ecosystem/*`): the exit code, the kept stderr lines, the results JSON and
// any `.snap` file, by `assertMatchesGolden` with no step of its own. Every fixture is two test
// files on one worker, so a package loaded once per worker is seen by the second file too.
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FIXTURES } from './recorded.ts'
import { assertMatchesGolden, provinoOn, WORK } from './recorded-run.ts'

/** The real directory of a package the harness installs (the project's own copy, as pnpm links it). */
function packageDir(name: string): string {
  const require = createRequire(join(FIXTURES, 'x.js'))
  return dirname(require.resolve(`${name}/package.json`))
}

/**
 * Where the projects go: a directory of this file's own under `.work/`, whose `node_modules` holds
 * the environment packages the harness installs (as `jest-dom.test.ts` links them into each
 * project), found by the upward walk from each project's root.
 */
const PARENT = join(WORK, 'ecosystem-dom')

/**
 * The fixtures held to their goldens. Five of them pass because a package that reads a per-file
 * global while it first loads in a worker (`expect`, a test hook, the environment's `document`)
 * is evaluated again for each later file, as Jest does (Phase 2d, D127 and P42:
 * `module.reevaluateHookingExternals`). The other two of the group are recorded and left out until
 * the work that makes them pass lands; each is named here with the reason:
 *
 * - `ecosystem/user-event-fake-timers`: the failure's code frame. Jest's caret for
 *   `await waitFor(…)` is under the call's `(` (column 16: babel-jest's CommonJS output calls
 *   `(0, _dom.waitFor)(…)`), Provino's under `waitFor` (column 9: the module-runner form calls
 *   `__vite_ssr_import_0__.waitFor(…)`), in both files' `failureMessage`. Not 2d's: the call
 *   position of an imported function through the transform.
 * - `ecosystem/jest-dom-jest-globals`: the same call position, in each test's `location`. The exit
 *   code, the kept stderr lines and every status match (the entry now resolves under Jest's CJS
 *   conditions to `dist/jest-globals.js`: `module.edgeResolveKind`); the 8 tests' `location.column`
 *   is 5 in Jest's results (`test` from `@jest/globals` is called as `(0, _globals.test)(…)`, whose
 *   position is the call's `(`) and 1 in Provino's (`__vite_ssr_import_1__.test(…)`).
 */
const FIXTURE_IDS = [
  ['ecosystem/jest-axe', 'toHaveNoViolations and configureAxe'],
  ['ecosystem/jest-dom-default', "the setupFilesAfterEnv module's expect.extend, in both files"],
  ['ecosystem/rtl-cleanup', "RTL's afterEach(cleanup) and screen, the second file's own"],
  ['ecosystem/jest-canvas-mock', "the setupFiles module's getContext mock, in both files"],
  [
    'ecosystem/jest-styled-components',
    'toHaveStyleRule, its serializer and its beforeEach, in both files',
  ],
] as const

/** Recorded, and left out until the work the comment above names lands. */
const LEFT_OUT: readonly string[] = [
  'ecosystem/user-event-fake-timers',
  'ecosystem/jest-dom-jest-globals',
]

/** The seven fixtures Phase 2a records (other phases add `ecosystem/*` fixtures of their own). */
const PHASE_2A: ReadonlySet<string> = new Set([
  'ecosystem/jest-axe',
  'ecosystem/jest-dom-default',
  'ecosystem/jest-dom-jest-globals',
  'ecosystem/rtl-cleanup',
  'ecosystem/jest-canvas-mock',
  'ecosystem/jest-styled-components',
  'ecosystem/user-event-fake-timers',
])

before(async () => {
  await mkdir(join(PARENT, 'node_modules'), { recursive: true })
  for (const name of ['jest-environment-jsdom', 'jest-environment-node']) {
    await rm(join(PARENT, 'node_modules', name), { force: true })
    await symlink(packageDir(name), join(PARENT, 'node_modules', name))
  }
})
after(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe('the ecosystem DOM packages through provino jest, against Jest 30.5.2', () => {
  it('runs every Phase 2a fixture or names why it does not', async () => {
    const phase2a = (await readdir(join(FIXTURES, 'ecosystem')))
      .map((name) => `ecosystem/${name}`)
      .filter((id) => PHASE_2A.has(id))
    assert.deepEqual(
      [...FIXTURE_IDS.map(([id]) => id), ...LEFT_OUT].toSorted(),
      [...PHASE_2A].toSorted(),
      'every Phase 2a fixture is held or left out with a reason',
    )
    assert.deepEqual(
      phase2a.toSorted(),
      [...PHASE_2A].toSorted(),
      'every Phase 2a fixture is recorded',
    )
  })

  for (const [id, title] of FIXTURE_IDS) {
    it(`${id}: ${title}`, async () => {
      assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
    })
  }
})
