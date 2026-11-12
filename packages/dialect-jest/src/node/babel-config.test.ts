// D68: when a project that names no `transform` runs the real babel-jest. Babel finds its config as
// `@babel/core`'s `loadPartialConfig` does for babel-jest's options (`cwd` and `root` = the project's
// `rootDir`, root mode "root", `babelrcRoots` defaulting to the root): a `babel.config.*` in the
// root, a `.babelrc*` there, or a `babel` key in the root's `package.json`.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { hasBabelConfig } from './babel-config.ts'
import { createJestConfigReader } from './index.ts'
import { oracleRequireResolve, removeTree, type Tree, writeTree } from './internal/test-support.ts'

const trees: string[] = []
after(() => {
  for (const tree of trees) removeTree(tree)
})

function tree(files: Tree): string {
  const root = writeTree(files)
  trees.push(root)
  return root
}

for (const name of [
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.json',
  'babel.config.cts',
  'babel.config.ts',
  '.babelrc',
  '.babelrc.js',
  '.babelrc.cjs',
  '.babelrc.mjs',
  '.babelrc.json',
  '.babelrc.cts',
]) {
  test(`${name} in the root is a Babel config`, () => {
    assert.equal(hasBabelConfig(tree({ [name]: '{}\n', 'package.json': '{}\n' })), true)
  })
}

test('a babel key in the root package.json is a Babel config', () => {
  assert.equal(hasBabelConfig(tree({ 'package.json': '{"babel":{"presets":[]}}\n' })), true)
})

test('no config file and no babel key is none', () => {
  assert.equal(hasBabelConfig(tree({ 'package.json': '{"name":"x"}\n' })), false)
  assert.equal(hasBabelConfig(tree({ 'jest.config.js': 'module.exports = {}\n' })), false)
})

test('a package.json that does not parse, or has a null babel key, is none', () => {
  assert.equal(hasBabelConfig(tree({ 'package.json': '{ not json' })), false)
  assert.equal(hasBabelConfig(tree({ 'package.json': '{"babel":null}\n' })), false)
})

test('a config below the root is not found (babelrcRoots defaults to the root)', () => {
  assert.equal(hasBabelConfig(tree({ 'sub/.babelrc': '{}\n', 'sub/babel.config.js': '' })), false)
})

test('a .babelrc below the root counts when the root is a package, not through another package or node_modules', () => {
  const pkg = '{}\n'
  assert.equal(hasBabelConfig(tree({ 'package.json': pkg, 'src/deep/.babelrc': '{}\n' })), true)
  assert.equal(hasBabelConfig(tree({ 'package.json': pkg, 'src/.babelrc.json': '{}\n' })), true)
  // Another package below the root is outside `babelrcRoots`.
  assert.equal(
    hasBabelConfig(tree({ 'package.json': pkg, 'pkg/package.json': pkg, 'pkg/.babelrc': '{}\n' })),
    false,
  )
  assert.equal(
    hasBabelConfig(tree({ 'package.json': pkg, 'node_modules/x/.babelrc': '{}\n' })),
    false,
  )
  assert.equal(hasBabelConfig(tree({ 'package.json': pkg, '.git/.babelrc': '{}\n' })), false)
  assert.equal(hasBabelConfig(tree({ 'package.json': pkg, 'src/a.js': '' })), false)
})

test('a project naming no transform keeps the default babel-jest entry only with a Babel config', async () => {
  const withConfig = tree({
    'jest.config.js': 'module.exports = {}\n',
    'babel.config.json': '{}\n',
  })
  const without = tree({ 'jest.config.js': 'module.exports = {}\n' })
  const read = async (root: string) => {
    const reader = createJestConfigReader({
      cwd: root,
      requireResolve: oracleRequireResolve,
      seed: 0,
    })
    const source = await reader.find(root)
    assert.ok(source !== undefined)
    const resolved = await reader.resolve(await reader.load(source), source)
    return reader.toNeutral(resolved.value).value[0]
  }
  const on = await read(withConfig)
  assert.equal(on?.transforms.length, 1)
  assert.match(on?.transforms[0]?.module ?? '', /babel-jest/)
  assert.deepEqual(on?.transformHoistedMarkers, ['_getJestObj'])
  assert.deepEqual((await read(without))?.transforms, [])
})
