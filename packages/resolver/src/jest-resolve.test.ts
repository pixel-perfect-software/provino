// T3.3: cases ported from jest-resolve 30.5.2's `src/__tests__/resolve.test.ts` (MIT, Meta): the
// `conditions` block (L179-L297), `resolveModule`'s custom paths (L619) and unmatched capture
// groups (L662), `core module specifiers`' `moduleNameMapper` block (L819-L888) and the custom
// resolver tests (L136, L647). The trees below are Jest's `__mocks__` fixtures written as data;
// the assertions are Jest's, with `findNodeModule` and `resolveModule` as `Resolver.resolve`.
// One case isn't portable: `conditions: []` ("gets default when nothing is passed"), because the
// call kind always adds `import` or `require`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { ResolveContext, ResolveKind, ResolveResult } from '@provino/types'
import { createNameMapper, jestModuleNameMapper } from './mappers.ts'
import { createResolver } from './resolver.ts'

const EXTENSIONS = ['.js', '.json', '.node']
const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-jest-resolve-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function ctx(
  importer: string,
  conditions: readonly string[] = [],
  kind: ResolveKind = 'require',
): ResolveContext {
  return { importer, kind, conditions }
}

function pathOf(result: ResolveResult): string {
  assert.equal(result.type, 'file', JSON.stringify(result))
  return result.type === 'file' ? result.path : ''
}

const CONDITIONS_TREE = {
  'a.js': '',
  'node_modules/main/package.json': JSON.stringify({ name: 'main', main: 'file.js' }),
  'node_modules/main/file.js': '',
  'node_modules/exports/package.json': JSON.stringify({
    name: 'import',
    main: 'main.js',
    exports: {
      '.': { require: './require.js', import: './import.js', default: './default.js' },
      './nested': './nestedDefault.js',
      './deeplyNested': { require: './nestedRequire.js', default: './nestedDefault.js' },
      './directory/*': './some-other-directory/*',
    },
  }),
  'node_modules/exports/main.js': '',
  'node_modules/exports/import.js': '',
  'node_modules/exports/require.js': '',
  'node_modules/exports/default.js': '',
  'node_modules/exports/nestedDefault.js': '',
  'node_modules/exports/nestedRequire.js': '',
  'node_modules/exports/some-other-directory/file.js': '',
}

test('conditions: exports pick by kind, main without exports, nested, wildcard', () => {
  const root = writeTree(CONDITIONS_TREE)
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS, tsconfig: false })
  const from = join(root, 'a.js')
  const at = (specifier: string, kind: ResolveKind, conditions: readonly string[] = []) =>
    pathOf(resolver.resolve(specifier, ctx(from, conditions, kind)))

  assert.equal(at('main', 'require'), join(root, 'node_modules/main/file.js'))
  assert.equal(at('exports', 'dynamic-import'), join(root, 'node_modules/exports/import.js'))
  assert.equal(at('exports', 'require'), join(root, 'node_modules/exports/require.js'))
  // Package order decides, not the order of the conditions.
  assert.equal(at('exports', 'require', ['import']), join(root, 'node_modules/exports/require.js'))
  assert.equal(at('exports', 'import', ['require']), at('exports', 'import', ['require', 'import']))
  assert.equal(at('exports/nested', 'require'), join(root, 'node_modules/exports/nestedDefault.js'))
  assert.equal(
    at('exports/directory/file', 'require'),
    join(root, 'node_modules/exports/some-other-directory/file.js'),
  )
  assert.equal(
    at('exports/directory/file.js', 'require'),
    join(root, 'node_modules/exports/some-other-directory/file.js'),
  )
  assert.equal(
    at('exports/deeplyNested', 'require'),
    join(root, 'node_modules/exports/nestedRequire.js'),
  )
  assert.equal(
    at('exports/deeplyNested', 'import'),
    join(root, 'node_modules/exports/nestedDefault.js'),
  )
})

test('an environment condition selects its export variant', () => {
  const root = writeTree({
    'a.js': '',
    'node_modules/dual/package.json': JSON.stringify({
      name: 'dual',
      exports: { browser: './browser.js', node: './node.js', default: './default.js' },
    }),
    'node_modules/dual/browser.js': '',
    'node_modules/dual/node.js': '',
    'node_modules/dual/default.js': '',
  })
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS, tsconfig: false })
  const from = join(root, 'a.js')
  assert.equal(
    pathOf(resolver.resolve('dual', ctx(from, ['browser'], 'require'))),
    join(root, 'node_modules/dual/browser.js'),
  )
  assert.equal(
    pathOf(resolver.resolve('dual', ctx(from, ['node'], 'require'))),
    join(root, 'node_modules/dual/node.js'),
  )
  // `customExportConditions: ['']` (react-hook-form): no condition names, so `default`.
  assert.equal(
    pathOf(resolver.resolve('dual', ctx(from, [''], 'require'))),
    join(root, 'node_modules/dual/default.js'),
  )
})

test('moduleNameMapper: unmatched capture groups are empty, targets resolve from the importer', () => {
  const root = writeTree({
    'src/a.js': '',
    'src/__mocks__/foo.js': '',
    'src/__mocks__/foo/bar/index.js': '',
  })
  const mapper = createNameMapper({
    rules: [{ pattern: '^@Foo(\\/.*)?$', targets: ['./__mocks__/foo$1'] }],
  })
  const resolver = createResolver({
    root,
    mappers: [mapper],
    extensions: EXTENSIONS,
    tsconfig: false,
  })
  const from = join(root, 'src/a.js')
  assert.equal(pathOf(resolver.resolve('@Foo', ctx(from))), join(root, 'src/__mocks__/foo.js'))
  assert.equal(
    pathOf(resolver.resolve('@Foo/bar', ctx(from))),
    join(root, 'src/__mocks__/foo/bar/index.js'),
  )
})

test('moduleNameMapper: rules run in order, array targets in order, <rootDir> expands', () => {
  const root = writeTree({
    'src/a.js': '',
    'lib/one.js': '',
    'lib/two.js': '',
    'lib/other.js': '',
  })
  const mapper = jestModuleNameMapper({
    rootDir: root,
    rules: [
      { pattern: '^lib/(.*)$', targets: ['<rootDir>/missing/$1', '<rootDir>/lib/$1'] },
      { pattern: '^lib/two$', targets: ['<rootDir>/lib/other'] },
    ],
  })
  const resolver = createResolver({
    root,
    mappers: [mapper],
    extensions: EXTENSIONS,
    tsconfig: false,
  })
  const from = join(root, 'src/a.js')
  // The first matching rule wins even though the second would match too; its second target hits.
  const two = resolver.resolve('lib/two', ctx(from))
  assert.equal(pathOf(two), join(root, 'lib/two.js'))
  assert.equal(two.type === 'file' && two.mappedBy, '/^lib\\/(.*)$/')
})

test('moduleNameMapper: the first match must resolve, and the miss names the rule and what it tried', () => {
  const root = writeTree({ 'src/a.js': '', 'real/x.js': '' })
  const mapper = createNameMapper({
    rootDir: root,
    rules: [
      { pattern: '^#(.*)$', targets: ['<rootDir>/nope/$1', '<rootDir>/nada/$1'] },
      { pattern: '^#x$', targets: ['<rootDir>/real/x'] },
    ],
  })
  const resolver = createResolver({
    root,
    mappers: [mapper],
    extensions: EXTENSIONS,
    tsconfig: false,
  })
  const miss = resolver.resolve('#x', ctx(join(root, 'src/a.js')))
  assert.equal(miss.type, 'not-found')
  assert.ok(miss.type === 'not-found')
  assert.equal(miss.mappedBy, '/^#(.*)$/')
  assert.deepEqual(miss.tried, [`${root}/nope/x`, `${root}/nada/x`])
  // The targets as configured, `$1` not replaced, for the dialect's error text.
  assert.deepEqual(miss.declared, [`${root}/nope/$1`, `${root}/nada/$1`])
})

test('moduleNameMapper: it matches the specifier as written (fs and node:fs are separate)', () => {
  const root = writeTree({ 'src/a.js': '', 'stub.js': '' })
  const from = join(root, 'src/a.js')
  const make = (pattern: string) =>
    createResolver({
      root,
      mappers: [createNameMapper({ rules: [{ pattern, targets: [join(root, 'stub')] }] })],
      extensions: EXTENSIONS,
      tsconfig: false,
    })
  const stub = join(root, 'stub.js')

  const bare = make('^fs$')
  assert.equal(pathOf(bare.resolve('fs', ctx(from))), stub)
  assert.deepEqual(bare.resolve('node:fs', ctx(from)), { type: 'builtin', id: 'node:fs' })

  const prefixed = make('^node:fs$')
  assert.equal(pathOf(prefixed.resolve('node:fs', ctx(from))), stub)
  assert.deepEqual(prefixed.resolve('fs', ctx(from)), { type: 'builtin', id: 'node:fs' })

  const both = make('^(node:)?fs$')
  assert.equal(pathOf(both.resolve('fs', ctx(from))), stub)
  assert.equal(pathOf(both.resolve('node:fs', ctx(from))), stub)

  assert.deepEqual(make('^test$').resolve('node:test', ctx(from)), {
    type: 'builtin',
    id: 'node:test',
  })
  // A double prefix isn't matched by a pattern for `node:fs` (jest: resolveStubModuleName is null).
  assert.equal(
    createNameMapper({ rules: [{ pattern: '^node:fs$', targets: ['x'] }] }).map(
      'node:node:fs',
      ctx(from),
    ),
    null,
  )
})

test('the mapper factory refuses a wrong shape with a coded error', () => {
  assert.throws(() => jestModuleNameMapper({ rules: 'x' }), { code: 'RESOLVER_BAD_MAPPER' })
  assert.throws(() => jestModuleNameMapper({ rules: [{ pattern: '(', targets: [] }] }), {
    code: 'RESOLVER_BAD_MAPPER',
  })
})

test('modulePaths: searched after the node_modules walk-up misses', () => {
  const root = writeTree({
    'src/a.js': '',
    'shared/only-here.js': '',
    'shared/also.js': '',
    'node_modules/also/index.js': '',
  })
  const resolver = createResolver({
    root,
    mappers: [],
    extensions: EXTENSIONS,
    tsconfig: false,
    modulePaths: [join(root, 'shared')],
  })
  const from = join(root, 'src/a.js')
  assert.equal(pathOf(resolver.resolve('only-here', ctx(from))), join(root, 'shared/only-here.js'))
  // A hit on the walk-up wins over the same name under `modulePaths`.
  assert.equal(
    pathOf(resolver.resolve('also', ctx(from))),
    join(root, 'node_modules/also/index.js'),
  )
  assert.equal(resolver.resolve('nowhere', ctx(from)).type, 'not-found')
})

test('moduleDirectories: replace node_modules', () => {
  const root = writeTree({
    'src/a.js': '',
    'vendor/lib/index.js': '',
    'node_modules/lib/index.js': '',
  })
  const resolver = createResolver({
    root,
    mappers: [],
    extensions: EXTENSIONS,
    tsconfig: false,
    moduleDirectories: ['vendor'],
  })
  assert.equal(
    pathOf(resolver.resolve('lib', ctx(join(root, 'src/a.js')))),
    join(root, 'vendor/lib/index.js'),
  )
})

test("custom resolver: called with Jest's options; a string answer wins; a throw is a miss", () => {
  const root = writeTree({ 'src/a.js': '', 'real.js': '' })
  const calls: { path: string; options: Record<string, unknown> }[] = []
  const resolver = createResolver({
    root,
    mappers: [],
    extensions: EXTENSIONS,
    tsconfig: false,
    modulePaths: ['/something'],
    custom: (path, options) => {
      calls.push({ path, options: { ...options } })
      if (path === 'boom') throw new Error('no')
      if (path === 'delegate') return options.defaultResolver('./real', options)
      return join(root, 'real.js')
    },
  })
  const from = join(root, 'src/a.js')
  assert.equal(
    pathOf(resolver.resolve('anything', ctx(from, ['x'], 'require'))),
    join(root, 'real.js'),
  )
  assert.equal(calls[0]?.path, 'anything')
  assert.equal(calls[0]?.options.basedir, join(root, 'src'))
  assert.deepEqual(calls[0]?.options.conditions, ['x', 'require'])
  assert.deepEqual(calls[0]?.options.extensions, EXTENSIONS)
  assert.deepEqual(calls[0]?.options.paths, ['/something'])
  assert.equal(calls[0]?.options.rootDir, root)
  assert.equal(typeof calls[0]?.options.defaultResolver, 'function')
  assert.equal(resolver.resolve('boom', ctx(from)).type, 'not-found')
  // The default resolver resolves from `basedir`.
  assert.equal(
    pathOf(resolver.resolve('delegate', ctx(join(root, 'real.js')))),
    join(root, 'real.js'),
  )
})

test('custom resolver is asked for builtins too (Jest skips its own core check when one is set)', () => {
  const root = writeTree({ 'a.js': '' })
  const asked: string[] = []
  const resolver = createResolver({
    root,
    mappers: [],
    extensions: EXTENSIONS,
    tsconfig: false,
    custom: {
      sync: (path) => {
        asked.push(path)
        return path
      },
    },
  })
  assert.deepEqual(resolver.resolve('fs', ctx(join(root, 'a.js'))), {
    type: 'builtin',
    id: 'node:fs',
  })
  assert.deepEqual(asked, ['fs'])
})
