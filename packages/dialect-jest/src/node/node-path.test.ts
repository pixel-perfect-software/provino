// jest-resolve reads `NODE_PATH` once and hands it to every resolver as `paths`; `defaultResolver`
// retries `paths` as the module directories when nothing resolves (`resolveWithPathsFallback`).
// pnpm's `.bin` shims set `NODE_PATH` to its hidden hoist directory, so a config module that only
// lives there is found. The in-process oracle reads `NODE_PATH` when it loads, so these cases are
// held to the recordings `cli/node-path-transform*` through the bin (`provino`'s
// `jest-node-path.test.ts`) instead.
import assert from 'node:assert/strict'
import { delimiter, join } from 'node:path'
import { afterAll, test } from 'provino'
import { oracleRequireResolve, removeTree, writeTree } from './internal/test-support.ts'
import { readJestConfig } from './normalize.ts'
import { tryRealpath } from './paths.ts'
import { createJestResolution } from './resolution.ts'

const trees: string[] = []
afterAll(() => {
  for (const tree of trees) removeTree(tree)
})

const TREE = {
  'hoisted/dep/package.json': '{ "name": "dep", "main": "index.js" }\n',
  'hoisted/dep/index.js': 'module.exports = {}\n',
  'resolver.cjs': 'module.exports = (path, options) => options.defaultResolver(path, options)\n',
  'seen.cjs':
    'module.exports = (path, options) => {\n  globalThis.__provinoSeenPaths = options.paths\n  return options.defaultResolver(path, options)\n}\n',
}

test('a module only NODE_PATH finds resolves through the default resolver', () => {
  const root = writeTree(TREE)
  trees.push(root)
  const hoisted = join(root, 'hoisted')
  assert.equal(
    createJestResolution(oracleRequireResolve).findNodeModule('dep', { basedir: root }),
    null,
  )
  assert.equal(
    createJestResolution(oracleRequireResolve, [hoisted]).findNodeModule('dep', { basedir: root }),
    join(hoisted, 'dep', 'index.js'),
  )
})

test('a custom resolver gets NODE_PATH as paths, and its defaultResolver retries them', async () => {
  const root = writeTree(TREE)
  trees.push(root)
  const hoisted = join(root, 'hoisted')
  const resolution = createJestResolution(oracleRequireResolve, [hoisted])
  try {
    for (const name of ['resolver.cjs', 'seen.cjs']) {
      const resolver = join(root, name)
      await resolution.preloadResolver(resolver)
      assert.equal(
        resolution.findNodeModule('dep', { basedir: root, resolver }),
        join(hoisted, 'dep', 'index.js'),
      )
    }
    assert.deepEqual(Reflect.get(globalThis, '__provinoSeenPaths'), [hoisted])
  } finally {
    Reflect.deleteProperty(globalThis, '__provinoSeenPaths')
  }
})

test('the reader takes NODE_PATH from its env, relative entries against the working directory', async () => {
  const root = writeTree({
    ...TREE,
    'jest.config.json': JSON.stringify({ setupFilesAfterEnv: ['dep'] }),
  })
  trees.push(root)
  const read = await readJestConfig(join(root, 'jest.config.json'), {
    cwd: root,
    env: { NODE_PATH: ['hoisted', ''].join(delimiter) },
    requireResolve: oracleRequireResolve,
    ci: false,
    seed: 0,
  })
  assert.deepEqual(read.projectConfig.setupFilesAfterEnv, [
    join(tryRealpath(root), 'hoisted', 'dep', 'index.js'),
  ])
})
