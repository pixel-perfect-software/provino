// T2.6's contract (B13d): a mock reaches the node_modules modules that import the mocked one, in
// that file only. The Done-when's own case runs on the installed `pretty-format` → `ansi-styles`
// (D53); the rest on small trees, with `ModulePolicy.mocksReachShared` both ways.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LoaderWarning, ModuleId } from '@provino/types'
import { initLexer } from './graph/index.ts'
import {
  at,
  fileWithMocks,
  JESTISH,
  loaderFor,
  VITESTISH,
  writeTree,
} from './internal/test-support.ts'

const factory = (value: unknown) => ({ kind: 'factory', factory: () => value }) as const

const PKG = (name: string, main = 'index.js') => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, main }),
})

/** pkg-a (CommonJS) requires pkg-b; pkg-c requires pkg-a. */
const CHAIN = {
  ...PKG('pkg-a'),
  'node_modules/pkg-a/index.js': "const b = require('pkg-b'); module.exports = { sees: b.name }",
  ...PKG('pkg-b'),
  'node_modules/pkg-b/index.js': "module.exports = { name: 'real b' }",
  ...PKG('pkg-c'),
  'node_modules/pkg-c/index.js': "const a = require('pkg-a'); module.exports = { sees: a.sees }",
  'user.js': "module.exports = require('pkg-c')",
  'a.test.js': '',
}

const FROM = (root: string) => at(root, 'a.test.js')

test("a mock reaches the importer, and the importer's importer, in that file only", () => {
  const root = writeTree(CHAIN)
  const loader = loaderFor(root)
  const first = fileWithMocks(loader, join(root, 'a.test.js')).files
  first.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  assert.equal(first.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'mock b')
  assert.equal(first.require<{ sees: string }>('pkg-c', FROM(root)).sees, 'mock b')
  const leaks = first.dispose()
  assert.deepEqual(leaks.inlinedForMocks.map((id) => id.slice(root.length + 1)).sort(), [
    'node_modules/pkg-a/index.js',
    'node_modules/pkg-c/index.js',
  ])
  // The next file, same loader: the real module, shared.
  const second = fileWithMocks(loader, join(root, 'b.test.js')).files
  assert.equal(second.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'real b')
  assert.equal(second.require<{ sees: string }>('pkg-c', FROM(root)).sees, 'real b')
  assert.deepEqual(second.dispose().inlinedForMocks, [])
})

test('the order of the files does not matter', () => {
  const root = writeTree(CHAIN)
  const loader = loaderFor(root)
  const real = fileWithMocks(loader, join(root, 'a.test.js')).files
  assert.equal(real.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'real b')
  real.dispose()
  const mocked = fileWithMocks(loader, join(root, 'b.test.js')).files
  mocked.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  assert.equal(mocked.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'mock b')
  mocked.dispose()
  const after = fileWithMocks(loader, join(root, 'c.test.js')).files
  assert.equal(after.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'real b')
})

for (const tier of ['registry', 'none'] as const) {
  test(`${tier}: the next file sees the shared module, with the mock in the file before`, () => {
    const root = writeTree(CHAIN)
    const loader = loaderFor(root)
    const mocked = fileWithMocks(loader, join(root, 'a.test.js'), { tier }).files
    mocked.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
    assert.equal(mocked.require<{ sees: string }>('pkg-c', FROM(root)).sees, 'mock b')
    mocked.dispose()
    const next = fileWithMocks(loader, join(root, 'b.test.js'), { tier }).files
    assert.equal(next.require<{ sees: string }>('pkg-c', FROM(root)).sees, 'real b')
    assert.equal(next.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'real b')
  })
}

test('under a policy where mocks do not reach shared modules, the importer sees the real one', async () => {
  const root = writeTree(CHAIN)
  const loader = loaderFor(root, { policy: VITESTISH })
  const files = fileWithMocks(loader, join(root, 'a.test.js'), { policy: VITESTISH }).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  assert.equal((await files.import<{ sees: string }>('pkg-a', FROM(root))).sees, 'real b')
  // A direct import is mocked under either policy.
  assert.equal((await files.import<{ name: string }>('pkg-b', FROM(root))).name, 'mock b')
  assert.deepEqual(files.dispose().inlinedForMocks, [])
})

test('requireActual of a package sees the mock of what it requires', () => {
  const root = writeTree(CHAIN)
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  files.registerMock('pkg-a', FROM(root), factory({ sees: 'mock a' }))
  assert.equal(files.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'mock a')
  assert.equal(files.requireActual<{ sees: string }>('pkg-a', FROM(root)).sees, 'mock b')
})

test('a nested copy of the mocked package, at another path, is untouched', () => {
  const root = writeTree({
    ...CHAIN,
    ...PKG('pkg-f'),
    'node_modules/pkg-f/index.js': "module.exports = { sees: require('pkg-b').name }",
    ...PKG('pkg-f/node_modules/pkg-b'),
    'node_modules/pkg-f/node_modules/pkg-b/index.js': "module.exports = { name: 'nested b' }",
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  assert.equal(files.require<{ sees: string }>('pkg-f', FROM(root)).sees, 'nested b')
  assert.equal(files.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'mock b')
})

test('a mocked builtin reaches the packages that require it', () => {
  const root = writeTree({
    ...PKG('pkg-os'),
    'node_modules/pkg-os/index.js': "module.exports = { sees: require('os').platform() }",
    'a.test.js': '',
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('os', FROM(root), factory({ platform: () => 'mock os' }))
  assert.equal(files.require<{ sees: string }>('pkg-os', FROM(root)).sees, 'mock os')
})

test('an ES module package that imports the mocked one is inlined too', async () => {
  const root = writeTree({
    ...PKG('pkg-b'),
    'node_modules/pkg-b/index.js': "module.exports = { name: 'real b' }",
    'node_modules/pkg-esm/package.json': JSON.stringify({
      name: 'pkg-esm',
      type: 'module',
      exports: './index.js',
    }),
    'node_modules/pkg-esm/index.js': "import b from 'pkg-b'\nexport const sees = b.name\n",
    'a.test.js': '',
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  assert.equal((await files.import<{ sees: string }>('pkg-esm', FROM(root))).sees, 'mock b')
})

test('a module already served keeps its instance: doMock after the load changes nothing, resetModules does', () => {
  const root = writeTree({
    ...CHAIN,
    ...PKG('pkg-e'),
    'node_modules/pkg-e/index.js': "module.exports = { sees: require('pkg-b').name }",
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  assert.equal(files.require<{ sees: string }>('pkg-e', FROM(root)).sees, 'real b')
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }), { hoisted: false })
  // Served before the mock existed: the same instance, as Jest's registry cache holds it.
  assert.equal(files.require<{ sees: string }>('pkg-e', FROM(root)).sees, 'real b')
  files.resetModules()
  assert.equal(files.require<{ sees: string }>('pkg-e', FROM(root)).sees, 'mock b')
})

test('an inlined module is served to every importer in the file as one instance', () => {
  const root = writeTree({
    ...CHAIN,
    ...PKG('pkg-counter'),
    'node_modules/pkg-counter/index.js':
      "require('pkg-b'); globalThis.__loads = (globalThis.__loads ?? 0) + 1; module.exports = { n: globalThis.__loads }",
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  const first = files.require('pkg-counter', FROM(root))
  assert.equal(files.require('pkg-counter', FROM(root)), first)
  Reflect.deleteProperty(globalThis, '__loads')
})

test('isolateModules decides afresh in its own layer', () => {
  const root = writeTree(CHAIN)
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  assert.equal(files.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'real b')
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  files.isolateModules(() => {
    assert.equal(files.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'mock b')
  })
  // Back outside: pkg-a was served shared before the mock, and still is.
  assert.equal(files.require<{ sees: string }>('pkg-a', FROM(root)).sees, 'real b')
})

test('a dynamic require inside an inlined module goes through the mocks at run time', () => {
  const root = writeTree({
    ...CHAIN,
    ...PKG('pkg-dyn'),
    'node_modules/pkg-dyn/index.js':
      "require('pkg-b'); module.exports = (name) => require(name).name",
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  const load = files.require<(name: string) => string>('pkg-dyn', FROM(root))
  assert.equal(load('pkg-b'), 'mock b')
})

test('a computed require in a shared closure is reported at debug level when mocks are active', () => {
  const root = writeTree({
    ...CHAIN,
    ...PKG('pkg-only-dyn'),
    'node_modules/pkg-only-dyn/index.js': 'module.exports = (name) => require(name)',
  })
  const warnings: LoaderWarning[] = []
  const files = fileWithMocks(
    loaderFor(root, { onWarning: (warning) => warnings.push(warning) }),
    join(root, 'a.test.js'),
  ).files
  files.require('pkg-only-dyn', FROM(root))
  assert.equal(warnings.length, 0, 'no mocks active: nothing to miss')
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  files.resetModules()
  files.require('pkg-only-dyn', FROM(root))
  assert.deepEqual(
    warnings.map((warning) => [warning.code, warning.level]),
    [['PROVINO_INLINE_DYNAMIC', 'debug']],
  )
})

test('the budget warns once per mocked module, and still inlines', () => {
  const root = writeTree(CHAIN)
  const warnings: LoaderWarning[] = []
  const loader = loaderFor(root, {
    inlineBudget: 1,
    onWarning: (warning) => warnings.push(warning),
  })
  for (const file of ['a.test.js', 'b.test.js']) {
    const files = fileWithMocks(loader, join(root, file)).files
    files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
    assert.equal(files.require<{ sees: string }>('pkg-c', FROM(root)).sees, 'mock b')
    files.dispose()
  }
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.code, 'PROVINO_INLINE_BUDGET')
  assert.equal(warnings[0]?.level, 'warn')
})

test('with no mock, nothing is scanned or cached', () => {
  const root = writeTree({ ...CHAIN, 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
  const cache = join(root, 'cache')
  const files = fileWithMocks(loaderFor(root, { graphCache: cache }), join(root, 'a.test.js')).files
  assert.equal(files.require<{ sees: string }>('pkg-c', FROM(root)).sees, 'real b')
  assert.deepEqual(files.dispose().inlinedForMocks, [])
  assert.equal(existsSync(join(cache, 'graph')), false)
})

test('a file with mocks scans once, and the graph is cached for the next worker', () => {
  const root = writeTree({ ...CHAIN, 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
  const cache = join(root, 'cache')
  const files = fileWithMocks(loaderFor(root, { graphCache: cache }), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  files.require('pkg-c', FROM(root))
  files.dispose()
  assert.equal(readdirSync(join(cache, 'graph')).length, 1)
})

test('a mocked module that is not reached by a package leaves it shared', () => {
  const root = writeTree({
    ...CHAIN,
    ...PKG('pkg-x'),
    'node_modules/pkg-x/index.js': 'module.exports = {}',
  })
  const files = fileWithMocks(loaderFor(root), join(root, 'a.test.js')).files
  files.registerMock('pkg-b', FROM(root), factory({ name: 'mock b' }))
  files.require('pkg-x', FROM(root))
  assert.deepEqual(files.dispose().inlinedForMocks, [])
})

// ---- the installed pretty-format → ansi-styles (the Done-when's own case, D53) ----

const STORE = fileURLToPath(new URL('../../../node_modules/.pnpm/', import.meta.url))
const PRETTY_FORMAT = join(STORE, 'pretty-format@30.5.1/node_modules/pretty-format')

/** `ansi-styles` as pretty-format resolves it (a different major than the others in the store). */
function ansiStylesOfPrettyFormat(): string {
  return realpathSync(createRequire(join(PRETTY_FORMAT, 'build/index.js')).resolve('ansi-styles'))
}

// pretty-format reads `ansi-styles` for the colours of the theme only under `highlight`, and only for
// an object (a primitive returns first). With no colours in the mock it throws, and with the real
// module it formats.
const noColours = {}

/** What formatting under `highlight` gives: the text, or the error pretty-format raises for a theme colour the mock lacks. */
function highlighted(format: Format['format']): string {
  try {
    format({ a: 1 }, { highlight: true })
    return 'formatted'
  } catch (error) {
    return error instanceof Error && /ansi-styles/.test(error.message)
      ? 'no colours'
      : 'other error'
  }
}

type Format = { format: (value: unknown, options?: object) => string }

test('pretty-format formats with the mocked ansi-styles in that file, and the real one in the next', async () => {
  assert.ok(existsSync(PRETTY_FORMAT), 'pretty-format 30.5.1 is installed')
  await initLexer()
  const ansi = ansiStylesOfPrettyFormat()
  const root = writeTree({ 'a.test.js': '' })
  const readLoaderOrder = (order: readonly ('mock' | 'real')[], tier: 'registry' | 'none') => {
    const loader = loaderFor(root)
    const seen: string[] = []
    const inlined: string[][] = []
    for (const [index, kind] of order.entries()) {
      const files = fileWithMocks(loader, join(root, `${index}.test.js`), { tier }).files
      if (kind === 'mock') files.registerMock(ansi, FROM(root), factory(noColours))
      const { format } = files.require<Format>(PRETTY_FORMAT, FROM(root))
      seen.push(highlighted(format))
      inlined.push(files.dispose().inlinedForMocks.map((id: ModuleId) => id))
    }
    return { seen, inlined }
  }
  for (const tier of ['registry', 'none'] as const) {
    for (const order of [
      ['mock', 'real'],
      ['real', 'mock', 'real'],
    ] as const) {
      const { seen, inlined } = readLoaderOrder(order, tier)
      assert.deepEqual(
        seen,
        order.map((kind) => (kind === 'mock' ? 'no colours' : 'formatted')),
        `${tier} ${order.join(',')}`,
      )
      for (const [index, kind] of order.entries()) {
        const files = inlined[index] ?? []
        assert.equal(files.length > 0, kind === 'mock')
        assert.ok(files.every((path) => path.startsWith(PRETTY_FORMAT)))
        if (kind === 'mock') assert.ok(files.some((path) => path.endsWith('build/index.js')))
      }
    }
  }
})

test('under a policy where mocks do not reach shared modules, pretty-format sees the real ansi-styles', async () => {
  await initLexer()
  const ansi = ansiStylesOfPrettyFormat()
  const root = writeTree({ 'a.test.js': '' })
  const files = fileWithMocks(loaderFor(root, { policy: VITESTISH }), join(root, 'a.test.js'), {
    policy: VITESTISH,
  }).files
  files.registerMock(ansi, FROM(root), factory(noColours))
  const { format } = files.require<Format>(PRETTY_FORMAT, FROM(root))
  assert.equal(highlighted(format), 'formatted')
  assert.equal(JESTISH.mocksReachShared, true)
})
