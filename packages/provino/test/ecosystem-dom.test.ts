// B23e Phase 2a: the ecosystem's DOM packages through `provino jest`, each held to the run Jest
// 30.5.2 recorded for it (`ecosystem/*`): the exit code, the kept stderr lines, the results JSON and
// any `.snap` file, by `assertMatchesGolden` with no step of its own. Every fixture is two test
// files on one worker, so a package loaded once per worker is seen by the second file too.
import { mkdir, rm, symlink } from 'node:fs/promises'
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
 * The fixtures held to their goldens. The other six of the group are recorded and left out until
 * the work that makes them pass lands; each is named here with the reason:
 *
 * - Phase 2d (D127): under isolation `registry` a package in `node_modules` is evaluated once per
 *   worker, so the second file loses what the package did as it loaded.
 *   - `ecosystem/jest-dom-default`: the `setupFilesAfterEnv` module's `expect.extend` (the second
 *     file's `.not.toBeInTheDocument` and the rest are not functions).
 *   - `ecosystem/rtl-cleanup`: RTL's `afterEach(cleanup)` and `screen`, bound to the first file's
 *     document (the second file's first render isn't found, and its body is never emptied).
 *   - `ecosystem/user-event-fake-timers`: dom-testing-library's `screen`, bound to the first file's
 *     document (the second file finds no button and no label).
 *   - `ecosystem/jest-canvas-mock`: the `setupFiles` module's `getContext` mock (`null` in the
 *     second file).
 *   - `ecosystem/jest-styled-components`: its `toHaveStyleRule`, its serializer and its
 *     `beforeEach(resetStyleSheet)` (the second file's snapshot has the generated class names).
 * - The loader: `ecosystem/jest-dom-jest-globals`. Jest runs the test file as CommonJS, so the
 *   entry resolves to `dist/jest-globals.js` under `require`; Provino resolves it under `import` to
 *   `dist/jest-globals.mjs`, whose `import { expect } from '@jest/globals'` fails to link against
 *   the served module, and the second file then fails with `ERR_REQUIRE_ESM_RACE_CONDITION`.
 */
const FIXTURE_IDS = [['ecosystem/jest-axe', 'toHaveNoViolations and configureAxe']] as const

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
  for (const [id, title] of FIXTURE_IDS) {
    it(`${id}: ${title}`, async () => {
      assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
    })
  }
})
