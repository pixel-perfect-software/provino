// T2.5's loader contract (B13c): what the loader owes the module-mock registry. Every edge
// (`import`, `require`, `import()` and a late import) asks `decide`; the actual paths bypass the
// mock of one module only; `resetModules` and `isolateModules` reach the registry; automock's real
// load is a scratch load; a `require` that doesn't resolve fails only when it runs; `none` shares
// what an earlier file bound; nothing is asked when there is no registry. The agreement with real
// Jest and Vitest is the harness's mod corpus; these pin the mechanism.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMockRegistry, createModuleMockRegistry } from '@provino/mock'
import { neutralPolicy } from '@provino/policy'
import type { HoistPolicy, MockDecision, ModuleMockRegistry, ModulePolicy } from '@provino/types'
import { at, fileWithMocks, HOIST, JESTISH, loaderFor, writeTree } from './internal/test-support.ts'

/** A registry that mocks nothing and records every `decide` it is asked. */
function recording(): { readonly registry: ModuleMockRegistry; readonly asked: string[] } {
  const asked: string[] = []
  const no: MockDecision = { mocked: false }
  const fail = (): never => {
    throw new Error('not part of the test')
  }
  return {
    asked,
    registry: {
      register: fail,
      decide: (id, _importer, kind, specifier) => {
        asked.push(`${kind} ${specifier ?? '?'} ${id.split('/').at(-1) ?? id}`)
        return no
      },
      decideUnresolved: (specifier) => {
        asked.push(`unresolved ${specifier}`)
        return no
      },
      materialize: fail,
      mockFor: fail,
      createMockFromModule: fail,
      onResetModules: () => asked.push('onResetModules'),
      setAutomock: fail,
      onGenerateMock: fail,
      enterIsolation: (caller) => asked.push(`enterIsolation ${caller ?? ''}`),
      exitIsolation: () => asked.push('exitIsolation'),
      dispose: () => asked.push('dispose'),
    },
  }
}

test('every edge asks decide: import, require, import() and a CommonJS require, with its specifier', async () => {
  const root = writeTree({
    'esm.ts': "import { b } from './b.ts'\nexport const a = b\n",
    'b.ts': 'export const b = 1\n',
    'cjs.cjs': "module.exports = require('./c.cjs')\n",
    'c.cjs': 'module.exports = 2\n',
    'entry.test.ts': [
      "import { a } from './esm.ts'",
      "import c from './cjs.cjs'",
      "export const later = () => import('./b.ts')",
      'export { a, c }',
      '',
    ].join('\n'),
  })
  const { registry, asked } = recording()
  const files = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
    moduleMocks: () => registry,
  })
  const entry = await files.import<{ later: () => Promise<unknown> }>(join(root, 'entry.test.ts'))
  await entry.later()
  assert.deepEqual(asked, [
    // The test file itself is the runner's load: never asked about.
    'esm ./esm.ts esm.ts',
    'esm ./b.ts b.ts',
    'esm ./cjs.cjs cjs.cjs',
    'cjs ./c.cjs c.cjs',
    'esm ./b.ts b.ts',
  ])
  files.dispose()
  assert.equal(asked.at(-1), 'dispose', 'the file registry disposes its module-mock registry')
})

test('registerMock serves the factory to every importer, and unregisterMock the real module again', async () => {
  const root = writeTree({
    'dep.ts': "export const value = 'real'\n",
    'user.ts': "import { value } from './dep.ts'\nexport const seen = value\n",
    'entry.test.ts': '',
  })
  const loader = loaderFor(root)
  const { files } = fileWithMocks(loader, join(root, 'entry.test.ts'))
  files.registerMock('./dep.ts', null, { kind: 'factory', factory: () => ({ value: 'mocked' }) })
  assert.equal(files.require<{ seen: string }>('./user.ts', at(root, 'x.ts')).seen, 'mocked')
  files.unregisterMock('./dep.ts', null)
  files.resetModules()
  assert.equal(files.require<{ seen: string }>('./user.ts', at(root, 'x.ts')).seen, 'real')
})

test('requireActual bypasses the mock of the module it names only: its own imports stay mocked', async () => {
  const root = writeTree({
    'inner.ts': "export const inner = 'real inner'\n",
    'outer.ts':
      "import { inner } from './inner.ts'\nexport const outer = 'real outer'\nexport { inner }\n",
    'entry.test.ts': '',
  })
  const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  files.registerMock('./outer.ts', null, { kind: 'factory', factory: () => ({ outer: 'mock' }) })
  files.registerMock('./inner.ts', null, {
    kind: 'factory',
    factory: () => ({ inner: 'mock inner' }),
  })
  const actual = files.requireActual<{ outer: string; inner: string }>('./outer.ts')
  assert.equal(actual.outer, 'real outer')
  assert.equal(actual.inner, 'mock inner')
  // Under `babel` the view is Babel's exports: a hidden `__esModule`, the names sorted.
  assert.deepEqual(Object.keys(actual), ['inner', 'outer'])
  assert.equal(Reflect.get(actual, '__esModule'), true)
})

test('resetModules and isolateModules reach the module-mock registry', async () => {
  const root = writeTree({ 'entry.test.ts': '' })
  const { registry, asked } = recording()
  const files = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
    moduleMocks: () => registry,
  })
  files.resetModules()
  files.isolateModules(() => {})
  await files.isolateModulesAsync(async () => {})
  assert.deepEqual(asked, [
    'onResetModules',
    'enterIsolation isolateModules',
    'exitIsolation',
    'enterIsolation isolateModulesAsync',
    'exitIsolation',
  ])
})

test('automock loads the real module in a scratch layer: a later real load evaluates it again', async () => {
  const root = writeTree({
    'counted.ts': [
      'const g = globalThis as { __loads?: number }',
      'g.__loads = (g.__loads ?? 0) + 1',
      'export function hello(): string { return "real" }',
      '',
    ].join('\n'),
    'entry.test.ts': '',
  })
  const g = globalThis as { __loads?: number }
  g.__loads = 0
  try {
    const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
    files.registerMock('./counted.ts', null, { kind: 'automock', spy: false })
    const mocked = files.require<{ hello: () => unknown }>('./counted.ts', at(root, 'a.ts'))
    assert.equal(mocked.hello(), undefined, 'an automock')
    assert.equal(g.__loads, 1, 'the real module ran once, in the scratch layer')
    assert.equal(files.requireActual<{ hello: () => string }>('./counted.ts').hello(), 'real')
    assert.equal(g.__loads, 2, 'the scratch instance is gone: the actual load runs it again')
    files.requireActual('./counted.ts')
    assert.equal(g.__loads, 2, 'and the actual instance stays')
  } finally {
    Reflect.deleteProperty(globalThis, '__loads')
  }
})

test('a require that does not resolve fails only when it runs, after a virtual mock had its say', async () => {
  const root = writeTree({
    'lazy.cjs': [
      'let optional = null',
      "try { optional = require('not-installed') } catch (error) { optional = error.code }",
      'exports.optional = optional',
      "exports.virtual = () => require('virtual-thing')",
      '',
    ].join('\n'),
    'entry.test.ts': '',
  })
  const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  const lazy = files.require<{ optional: unknown; virtual: () => unknown }>(
    './lazy.cjs',
    at(root, 'a.ts'),
  )
  assert.equal(lazy.optional, 'MODULE_NOT_FOUND')
  assert.throws(() => lazy.virtual(), { code: 'MODULE_NOT_FOUND', name: 'Error' })
  files.registerMock(
    'virtual-thing',
    null,
    { kind: 'factory', factory: () => 'virtual' },
    {
      virtual: true,
    },
  )
  assert.equal(lazy.virtual(), 'virtual')
})

test('a missing import reads the dialect’s module-not-found text, with the importer relative to the root', async () => {
  const root = writeTree({ 'entry.test.ts': "import './nowhere.ts'\n" })
  const loader = loaderFor(root, {
    policy: { messages: { 'module-not-found': "no '{specifier}' from '{from}'" } },
  })
  const files = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  await assert.rejects(files.import(join(root, 'entry.test.ts')), {
    code: 'ERR_MODULE_NOT_FOUND',
    message: "no './nowhere.ts' from 'entry.test.ts'",
  })
})

test('a transform error reads the dialect’s transform-failed text, the code frame after a blank line', async () => {
  const root = writeTree({
    'entry.test.ts': "const outside = 1\nmocker.mock('./x.ts', 5)\n",
  })
  const strict: HoistPolicy = {
    ...HOIST,
    factoryReferences: { allowGlobals: new Set(), allowPattern: /^mock/, hoistPureConsts: false },
  }
  const loader = loaderFor(root, {
    hoist: strict,
    policy: { messages: { 'transform-failed': '{file}: {message}' } },
  })
  const files = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  await assert.rejects(files.import(join(root, 'entry.test.ts')), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'LOADER_TRANSFORM_FAILED')
    const [first, blank] = String((error as Error).message).split('\n')
    assert.equal(first, `${join(root, 'entry.test.ts')}: not a function`)
    assert.equal(blank, '', 'the code frame starts after a blank line')
    return true
  })
})

test('require() of an ES module that hoists works: its late imports load synchronously (D38)', async () => {
  const root = writeTree({
    'dep.ts': "export const value = 'real'\n",
    'helper.ts': [
      "import { value } from './dep.ts'",
      "mocker.mock('./dep.ts', () => ({ value: 'mocked' }))",
      'export const seen = value',
      '',
    ].join('\n'),
    'entry.test.ts': '',
  })
  const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  const helper = files.require<{ seen: string }>('./helper.ts', at(root, 'a.cjs'))
  assert.equal(helper.seen, 'mocked')
  // The same file loaded by `import` takes the async path, with the same answer.
  const { files: other } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  assert.equal(
    (await other.import<{ seen: string }>('./helper.ts', at(root, 'a.ts'))).seen,
    'mocked',
  )
})

test('a late import of a module with top-level await works through import, and is refused by require', async () => {
  const root = writeTree({
    'slow.ts': 'export const value: number = await Promise.resolve(7)\n',
    'helper.ts':
      "import { value } from './slow.ts'\nmocker.mock('./other.ts')\nexport const seen = value\n",
    'other.ts': 'export const other = 1\n',
    'entry.test.ts': '',
  })
  const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  assert.equal((await files.import<{ seen: number }>('./helper.ts', at(root, 'a.ts'))).seen, 7)
  const { files: sync } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  assert.throws(() => sync.require('./helper.ts', at(root, 'a.cjs')), {
    code: 'ERR_REQUIRE_ASYNC_MODULE',
  })
})

test('each module gets its own scope bindings; a module that names none is never asked about', async () => {
  const root = writeTree({
    'named.ts': 'export const who = mocker.who\n',
    'plain.ts': 'export const plain = 1\n',
    // Its own `const require` must not clash with the injected one.
    'own-require.ts':
      "import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\nexport const ok = typeof require\n",
    'entry.test.ts': '',
  })
  const asked: string[] = []
  const files = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
    moduleScope: (from) => {
      asked.push(from.split('/').at(-1) ?? from)
      return { mocker: { who: from.split('/').at(-1) } }
    },
  })
  const importer = at(root, 'a.ts')
  assert.equal((await files.import<{ who: string }>('./named.ts', importer)).who, 'named.ts')
  assert.equal((await files.import<{ plain: number }>('./plain.ts', importer)).plain, 1)
  assert.equal((await files.import<{ ok: string }>('./own-require.ts', importer)).ok, 'function')
  assert.deepEqual(asked, ['named.ts'])
})

test('an ES module gets require, __filename and __dirname under injectCjsGlobals', async () => {
  const root = writeTree({
    'cjs.cjs': 'module.exports = 3\n',
    'esm.ts':
      "export const viaRequire = require('./cjs.cjs')\nexport const file = __filename\nexport const dir = __dirname\n",
    'entry.test.ts': '',
  })
  const injected = loaderFor(root, { policy: { injectCjsGlobals: true } }).createFileRegistry(
    join(root, 'entry.test.ts'),
    { tier: 'registry' },
  )
  const esm = await injected.import<{ viaRequire: number; file: string; dir: string }>(
    './esm.ts',
    at(root, 'a.ts'),
  )
  assert.deepEqual({ ...esm }, { viaRequire: 3, file: join(root, 'esm.ts'), dir: root })
  const bare = loaderFor(root, { policy: { injectCjsGlobals: false } }).createFileRegistry(
    join(root, 'entry.test.ts'),
    { tier: 'registry' },
  )
  await assert.rejects(bare.import('./esm.ts', at(root, 'a.ts')), ReferenceError)
})

test('a file whose only module syntax is import() runs in module form (format unknown)', async () => {
  const root = writeTree({
    'later.ts': 'export const late = 5\n',
    'entry.test.ts': "globalThis.__late = import('./later.ts')\n",
  })
  const files = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  try {
    await files.import(join(root, 'entry.test.ts'))
    const loaded = await (globalThis as { __late?: Promise<{ late: number }> }).__late
    assert.equal(loaded?.late, 5)
  } finally {
    Reflect.deleteProperty(globalThis, '__late')
  }
})

test('none with mocks: each file gets its own module-mock registry; a module an earlier file bound keeps it', async () => {
  const root = writeTree({
    'dep.ts': "export const value = 'real'\n",
    'shared.ts': "import { value } from './dep.ts'\nexport const seen = value\n",
    'a.test.ts': '',
    'b.test.ts': '',
  })
  const loader = loaderFor(root)
  const a = fileWithMocks(loader, join(root, 'a.test.ts'), { tier: 'none' })
  a.files.registerMock('./dep.ts', null, {
    kind: 'factory',
    factory: () => ({ value: 'mocked in a' }),
  })
  assert.equal(
    a.files.require<{ seen: string }>('./shared.ts', at(root, 'x.ts')).seen,
    'mocked in a',
  )
  const firstMocks = a.mocks()
  a.files.dispose()
  const b = fileWithMocks(loader, join(root, 'b.test.ts'), { tier: 'none' })
  assert.notEqual(b.mocks(), firstMocks, 'a new module-mock registry for the second file')
  // The worker's shared instance map keeps what the first file evaluated, as Vitest's
  // `isolate: false` does (B13c Gap 9).
  assert.equal(
    b.files.require<{ seen: string }>('./shared.ts', at(root, 'x.ts')).seen,
    'mocked in a',
  )
  // A module it loads for the first time sees its own registrations.
  b.files.registerMock('./dep.ts', null, {
    kind: 'factory',
    factory: () => ({ value: 'mocked in b' }),
  })
  b.files.invalidate('./shared.ts')
  assert.equal(
    b.files.require<{ seen: string }>('./shared.ts', at(root, 'x.ts')).seen,
    'mocked in b',
  )
  b.files.dispose()
})

test('with no module-mock registry, nothing is asked and registering is refused', async () => {
  const root = writeTree({
    'dep.ts': 'export const d = 1\n',
    'entry.test.ts': "export { d } from './dep.ts'\n",
  })
  const files = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  assert.equal((await files.import<{ d: number }>(join(root, 'entry.test.ts'))).d, 1)
  assert.throws(() => files.registerMock('./dep.ts', null, { kind: 'unmock' }), {
    code: 'LOADER_NO_MODULE_MOCKS',
  })
})

test('a test file that fails to load on an unresolved relative mock names itself when the dialect asks', async () => {
  const root = writeTree({ 'entry.test.ts': "import './missing.ts'\n" })
  const policy: Partial<ModulePolicy> = {
    requireVirtualFlag: false,
    virtualRelative: false,
    messages: {
      'unresolved-relative-mock': "Cannot find module '{id}'",
      'unresolved-mock-import': '{message} imported from {importer}',
    },
  }
  const loader = loaderFor(root, { policy })
  const file = join(root, 'entry.test.ts')
  const files = loader.createFileRegistry(file, {
    tier: 'registry',
    moduleMocks: (context) =>
      createModuleMockRegistry({
        policy: { ...neutralPolicy.module, ...JESTISH, ...policy },
        mockPolicy: neutralPolicy.mock,
        mocks: createMockRegistry(),
        resolver: context.resolver,
        roots: [root],
        extensions: ['.ts'],
        loadActual: context.loadActual,
      }),
  })
  files.registerMock('./missing.ts', null, { kind: 'factory', factory: () => ({}) })
  await assert.rejects(files.import(file), {
    code: 'LOADER_UNRESOLVED_MOCK',
    message: `Cannot find module '/missing.ts' imported from ${file}`,
  })
})
