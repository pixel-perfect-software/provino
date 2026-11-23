// A `jest.mock` factory that reads `window` and a module-scope variable not prefixed `mock`, through
// `provino jest`, held to the runs Jest 30.5.2 recorded (`cli/transform-*-factory-scope`). Jest's
// out-of-scope check is babel-plugin-jest-hoist's, which only babel-jest runs: a project whose
// transform is `@swc/jest` runs the factory and passes, and the same test under babel-jest fails at
// transform with Babel's error. Provino's hoister checks factories only in the output of a rule the
// dialect marks `checksMockFactories` (babel-jest's), and still hoists every other transformer's.
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'provino'
import {
  assertMatchesGolden,
  linkEnvironments,
  packageDir,
  provinoOn,
  WORK,
} from './recorded-run.ts'

/** The projects' parent: its `node_modules` holds the environments and the transformer. */
const PARENT = join(WORK, 'transform-factory-scope')

const SWC = 'cli/transform-swc-factory-scope'
const BABEL = 'cli/transform-babel-jest-factory-scope'

beforeAll(async () => {
  await linkEnvironments(PARENT)
  await mkdir(join(PARENT, 'node_modules', '@swc'), { recursive: true })
  for (const name of ['@swc/jest', '@swc/core']) {
    await rm(join(PARENT, 'node_modules', name), { force: true })
    await symlink(packageDir(name), join(PARENT, 'node_modules', name))
  }
})
afterAll(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe('a mock factory that reads outside names, by transformer, against Jest 30.5.2', () => {
  it(`${SWC}: @swc/jest hoists and checks nothing: the factory runs, both tests pass`, async () => {
    assertMatchesGolden(SWC, await provinoOn(SWC, { parent: PARENT }))
  })

  it(`${BABEL}: babel-jest refuses the factory with Babel's out-of-scope error, exit 1`, async () => {
    assertMatchesGolden(BABEL, await provinoOn(BABEL, { parent: PARENT }))
  })
})
