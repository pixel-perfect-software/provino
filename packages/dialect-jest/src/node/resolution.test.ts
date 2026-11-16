// A custom `resolver` module is loaded once (jest-resolve's `preloadResolver`): its code runs one
// time, a module with only named `sync`/`async` exports is a resolver as its namespace is, and
// resolution then goes through it.
import assert from 'node:assert/strict'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { JestConfigError } from './errors.ts'
import { oracleRequireResolve, removeTree, writeTree } from './internal/test-support.ts'
import { readJestConfigs } from './normalize.ts'
import { createJestResolution } from './resolution.ts'

const trees: string[] = []
after(() => {
  for (const tree of trees) removeTree(tree)
})

test('a resolver with only named exports is loaded once and used', async () => {
  const root = writeTree({
    'resolver.mjs': `globalThis.__provinoResolverLoads = (globalThis.__provinoResolverLoads ?? 0) + 1
export function sync(path, options) {
  return options.defaultResolver(path === 'alias' ? './target.js' : path, options)
}
`,
    'target.js': '',
  })
  trees.push(root)
  Reflect.set(globalThis, '__provinoResolverLoads', 0)
  const resolution = createJestResolution(oracleRequireResolve)
  const resolver = join(root, 'resolver.mjs')
  await resolution.preloadResolver(resolver)
  await resolution.preloadResolver(resolver)
  assert.equal(Reflect.get(globalThis, '__provinoResolverLoads'), 1)
  assert.equal(
    resolution.findNodeModule('alias', { basedir: root, resolver }),
    join(root, 'target.js'),
  )
})

test('a CommonJS resolver function is the resolver', async () => {
  const root = writeTree({
    'resolver.js':
      "module.exports = (path, options) => options.defaultResolver(path.replace(/^@@/, './'), options)\n",
    'x.js': '',
  })
  trees.push(root)
  const resolution = createJestResolution(oracleRequireResolve)
  const resolver = join(root, 'resolver.js')
  await resolution.preloadResolver(resolver)
  assert.equal(resolution.findNodeModule('@@x.js', { basedir: root, resolver }), join(root, 'x.js'))
})

/** A CommonJS resolver that requires something and counts its loads in `globalThis[counter]`. */
function countingResolver(counter: string): string {
  return [
    "'use strict'",
    "const { extname } = require('node:path')",
    `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1`,
    'module.exports = (path, options) =>',
    "  options.defaultResolver(extname(path) === '' ? `${path}.js` : path, options)",
    '',
  ].join('\n')
}

// Each project's normalize preloads the resolver, and `readJestConfigs` reads the projects at once,
// as Jest's `readConfigs` does. A load per project, each a fresh `import()` that deleted the
// file's `require.cache` entry, once failed with Node's `ERR_INTERNAL_ASSERTION`
// (ts-jest-resolver's `dist/index.cjs` in a pnpm monorepo). jest-resolve loads it once per process.
test('projects read at once share one load of a CommonJS resolver', async () => {
  const config = JSON.stringify({ resolver: '<rootDir>/../resolver.cjs' })
  const root = writeTree({
    'resolver.cjs': countingResolver('__provinoSharedResolverLoads'),
    'a/jest.config.json': config,
    'b/jest.config.json': config,
    'c/jest.config.json': config,
  })
  trees.push(root)
  try {
    const read = await readJestConfigs(
      ['a', 'b', 'c'].map((project) => join(root, project)),
      { cwd: root, requireResolve: oracleRequireResolve, ci: false, seed: 0 },
    )
    assert.deepEqual(
      read.configs.map((project) => project.resolver),
      ['a', 'b', 'c'].map(() => join(root, 'resolver.cjs')),
    )
    assert.equal(Reflect.get(globalThis, '__provinoSharedResolverLoads'), 1)
  } finally {
    Reflect.deleteProperty(globalThis, '__provinoSharedResolverLoads')
  }
})

test('a resolver two projects name by different spellings of its path loads once', async () => {
  const root = writeTree({
    'real/resolver.cjs': countingResolver('__provinoSpelledResolverLoads'),
    'x.js': '',
  })
  trees.push(root)
  symlinkSync(join(root, 'real'), join(root, 'alias'))
  const real = join(root, 'real', 'resolver.cjs')
  const alias = join(root, 'alias', 'resolver.cjs')
  const first = createJestResolution(oracleRequireResolve)
  const second = createJestResolution(oracleRequireResolve)
  try {
    await Promise.all([first.preloadResolver(real), second.preloadResolver(alias)])
    assert.equal(Reflect.get(globalThis, '__provinoSpelledResolverLoads'), 1)
    assert.equal(first.findNodeModule('./x', { basedir: root, resolver: real }), join(root, 'x.js'))
    assert.equal(
      second.findNodeModule('./x', { basedir: root, resolver: alias }),
      join(root, 'x.js'),
    )
  } finally {
    Reflect.deleteProperty(globalThis, '__provinoSpelledResolverLoads')
  }
})

// jest-resolve lets what `require` threw out as it is, and jest-cli prints its stack: the error
// keeps a short message and carries that error, which `provino jest` prints (`cli/resolver-load-error`).
test("a resolver that can't load is refused with what it threw as the cause", async () => {
  const root = writeTree({ 'resolver.cjs': "require('./missing-helper.cjs')\n" })
  trees.push(root)
  const resolver = join(root, 'resolver.cjs')
  await assert.rejects(
    createJestResolution(oracleRequireResolve).preloadResolver(resolver),
    (error: unknown) => {
      assert.ok(error instanceof JestConfigError)
      assert.equal(error.code, 'JEST_CONFIG_RESOLVER_LOAD_FAILED')
      assert.equal(error.message, `can't load the resolver "${resolver}"`)
      const { cause } = error
      assert.ok(cause instanceof Error)
      assert.equal(Reflect.get(cause, 'code'), 'MODULE_NOT_FOUND')
      assert.equal(cause.message.split('\n')[0], "Cannot find module './missing-helper.cjs'")
      return true
    },
  )
})

test("a module that exports no resolver is refused with jest-resolve's text", async () => {
  const root = writeTree({ 'resolver.mjs': 'export const nothing = 1\n' })
  trees.push(root)
  const resolver = join(root, 'resolver.mjs')
  await assert.rejects(createJestResolution(oracleRequireResolve).preloadResolver(resolver), {
    code: 'JEST_CONFIG_LOAD_FAILED',
    message: `Resolver located at ${resolver} does not export a function or an object with "sync" and "async" props`,
  })
})
