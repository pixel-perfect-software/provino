// A `jest.mock` factory that reads `window` and a module-scope variable not prefixed `mock`, through
// `provino jest`, held to the runs Jest 30.5.2 recorded (`cli/transform-*-factory-scope`). Jest's
// out-of-scope check is babel-plugin-jest-hoist's, which only babel-jest runs: a project whose
// transform is `@swc/jest` runs the factory and passes, and the same test under babel-jest fails at
// transform with Babel's error. Provino's hoister checks factories only in the output of a rule the
// dialect marks `checksMockFactories` (babel-jest's), and still hoists every other transformer's.
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
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

before(async () => {
  await linkEnvironments(PARENT)
  await mkdir(join(PARENT, 'node_modules', '@swc'), { recursive: true })
  for (const name of ['@swc/jest', '@swc/core']) {
    await rm(join(PARENT, 'node_modules', name), { force: true })
    await symlink(packageDir(name), join(PARENT, 'node_modules', name))
  }
})
after(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

/** Babel's error from the file's transform, as each runner heads it; the rest of the text is one. */
function babelFailure(header: string): string {
  return [
    'FAIL ./factory-scope.test.tsx',
    '  ● Test suite failed to run',
    `    ${header}: The module factory of \`jest.mock()\` is not allowed to reference any out-of-scope variables.`,
    '    Invalid variable access: window',
    'Test Suites: 1 failed, 1 total',
    'Tests:       0 total',
  ].join('\n')
}

describe('a mock factory that reads outside names, by transformer, against Jest 30.5.2', () => {
  it(`${SWC}: @swc/jest hoists and checks nothing: the factory runs, both tests pass`, async () => {
    assertMatchesGolden(SWC, await provinoOn(SWC, { parent: PARENT }))
  })

  it(`${BABEL}: babel-jest refuses the factory with Babel's out-of-scope error, exit 1`, async () => {
    assertMatchesGolden(BABEL, await provinoOn(BABEL, { parent: PARENT }), {
      declared: {
        stderr: {
          golden: babelFailure('ReferenceError: <root>/factory-scope.test.tsx'),
          provino: babelFailure(
            'LoaderError: <root>/factory-scope.test.tsx: <root>/factory-scope.test.tsx',
          ),
          reason:
            "the Jest dialect's `transform-failed` text puts the file before a hosted transformer's message, which Babel's already starts with, and the loader's error replaces the class the transformer threw (Babel's ReferenceError): the same for any transformer that throws, not this check's",
        },
      },
    })
  })
})
