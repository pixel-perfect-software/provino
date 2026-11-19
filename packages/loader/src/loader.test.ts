import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { createResolver } from '@provino/resolver'
import type {
  CompiledModuleEvent,
  Loader,
  LoaderWarning,
  ModuleId,
  ModuleMockRegistry,
  ModulePolicy,
  Resolver,
  TransformClaims,
} from '@provino/types'
import { RequireEsmError } from './errors.ts'
import { HOIST, type LoaderOptionsExtra, loaderOptionsFor } from './internal/test-support.ts'
import { createLoader } from './loader.ts'
import { tierFor } from './tier.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function loaderFor(
  root: string,
  policy: Partial<ModulePolicy> = {},
  extra: Omit<LoaderOptionsExtra, 'policy'> = {},
): Loader {
  return createLoader(loaderOptionsFor(root, { ...extra, policy }))
}

interface CounterModule {
  readonly bump: () => number
  readonly count: number
}

const COUNTER = {
  'counter.ts': 'export let count: number = 0\nexport function bump(): number { return ++count }\n',
  'a.test.ts': "export { bump, count } from './counter.ts'\n",
  'b.test.ts': "export { bump, count } from './counter.ts'\n",
}

test('the loader’s tierFor is the one the coordinator calls', () => {
  const loader = loaderFor(tmpdir())
  assert.equal(loader.tierFor, tierFor)
  assert.deepEqual(
    loader.tierFor('a.test.ts', {
      configured: 'registry',
      docblock: { 'provino-isolate': 'realm' },
    }),
    {
      tier: 'realm',
      source: 'docblock',
      warnings: [],
    },
  )
})

test('registry: each file gets fresh user modules; none: the worker shares them', async () => {
  const root = writeTree(COUNTER)
  const loader = loaderFor(root)
  const file = (name: string, tier: 'registry' | 'none') =>
    loader.createFileRegistry(join(root, name), { tier })

  const a = await file('a.test.ts', 'registry').import<CounterModule>(join(root, 'a.test.ts'))
  a.bump()
  a.bump()
  const b = await file('b.test.ts', 'registry').import<CounterModule>(join(root, 'b.test.ts'))
  assert.equal(b.bump(), 1, 'registry: b sees a fresh counter')

  const c = await file('a.test.ts', 'none').import<CounterModule>(join(root, 'a.test.ts'))
  c.bump()
  const d = await file('b.test.ts', 'none').import<CounterModule>(join(root, 'b.test.ts'))
  assert.equal(d.bump(), 2, 'none: d shares c’s counter')
})

test('exports are live bindings, and cycles see each other', async () => {
  const root = writeTree({
    ...COUNTER,
    'm5.ts':
      "import { fromM6 } from './m6.ts'\nexport const name = 'm5'\nexport function viaM6(): string { return fromM6() }\n",
    'm6.ts':
      "import { name } from './m5.ts'\nexport function fromM6(): string { return 'm6 sees ' + name }\n",
    'entry.test.ts': "export { viaM6 } from './m5.ts'\nexport * from './counter.ts'\n",
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const entry = await registry.import<CounterModule & { viaM6: () => string }>(
    join(root, 'entry.test.ts'),
  )
  assert.equal(entry.count, 0)
  entry.bump()
  assert.equal(entry.count, 1, 'the re-exported binding is live')
  assert.equal(entry.viaM6(), 'm6 sees m5')
})

test('top-level await makes its importers async, and require() of them throws', async () => {
  const root = writeTree({
    'slow.ts': 'export const value: number = await Promise.resolve(42)\n',
    'uses-slow.ts': "import { value } from './slow.ts'\nexport const doubled = value * 2\n",
    'sync.ts': 'export const plain = 1\n',
    'entry.test.ts': '',
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const used = await registry.import<{ doubled: number }>(join(root, 'uses-slow.ts'))
  assert.equal(used.doubled, 84)
  assert.throws(() => registry.require(join(root, 'uses-slow.ts')), {
    code: 'ERR_REQUIRE_ASYNC_MODULE',
  })
  assert.deepEqual({ ...registry.require<{ plain: number }>(join(root, 'sync.ts')) }, { plain: 1 })
})

test('a link that throws partway still gets its async graphs marked by the next link', async () => {
  const root = writeTree({
    'slow.ts': 'export const value: number = await Promise.resolve(42)\n',
    // A missing import no longer fails the link (it fails when its edge runs), but a file that
    // doesn't transform still does.
    'broken.ts': "import './bad.ts'\nexport const broken = 1\n",
    'bad.ts': 'export const = 1\n',
    // `half.ts` resolves both of its imports before the walk reaches `bad.ts` and throws,
    // whichever order the walk takes them in.
    'half.ts': "import './slow.ts'\nimport './broken.ts'\nexport const half = 1\n",
    'entry.test.ts': '',
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  await assert.rejects(registry.import(join(root, 'half.ts')), { code: 'LOADER_TRANSFORM_FAILED' })
  // `half.ts` stays linked with `slow.ts` resolved, and nothing marked it. This second link finds
  // nothing new to link, but still has to mark it: its graph has top-level await.
  assert.throws(() => registry.require(join(root, 'half.ts')), { code: 'ERR_REQUIRE_ASYNC_MODULE' })
})

test('CommonJS user modules: require, module.exports and the default interop', async () => {
  const files = {
    'lib.cjs':
      "const helper = require('./helper.cjs')\nmodule.exports = { greet: (n) => helper.prefix + n }\n",
    'helper.cjs': "exports.prefix = 'hi '\n",
    'esm-shaped.cjs':
      "Object.defineProperty(exports, '__esModule', { value: true })\nexports.default = 'inner default'\nexports.named = 'named'\n",
    'entry.test.ts':
      "import lib from './lib.cjs'\nimport shaped, { named } from './esm-shaped.cjs'\nexport const greeting = lib.greet('ada')\nexport { shaped, named }\n",
  }
  const babel = loaderFor(writeTree(files), { interopDefault: 'babel' })
  const babelRoot = roots.at(-1) ?? ''
  const viaBabel = await babel
    .createFileRegistry(join(babelRoot, 'entry.test.ts'), { tier: 'registry' })
    .import<{ greeting: string; shaped: unknown; named: string }>(join(babelRoot, 'entry.test.ts'))
  assert.equal(viaBabel.greeting, 'hi ada')
  assert.equal(viaBabel.shaped, 'inner default', 'babel interop honours __esModule')
  assert.equal(viaBabel.named, 'named')

  const nodeRoot = writeTree(files)
  const viaNode = await loaderFor(nodeRoot, { interopDefault: 'node' })
    .createFileRegistry(join(nodeRoot, 'entry.test.ts'), { tier: 'registry' })
    .import<{ shaped: unknown }>(join(nodeRoot, 'entry.test.ts'))
  assert.equal(
    (viaNode.shaped as { default: unknown }).default,
    'inner default',
    'node interop: default is module.exports',
  )
})

test('a hashbang starts a module and a CommonJS file, as Node reads them', async () => {
  const root = writeTree({
    'dep.js': 'export const base = 40\n',
    'cli.mjs':
      "#!/usr/bin/env node\nimport { base } from './dep.js'\nexport const answer = base + 2\n",
    'plain.mjs': '#!/usr/bin/env node\nexport const plain = 1\n',
    'tool.cjs': '#!/usr/bin/env node\nexports.ok = true\nexports.sum = 1 + 2\n',
    'entry.test.ts':
      "import { answer } from './cli.mjs'\nimport { plain } from './plain.mjs'\nimport tool from './tool.cjs'\nexport { answer, plain, tool }\n",
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const entry = await registry.import<{
    answer: number
    plain: number
    tool: { ok: boolean; sum: number }
  }>(join(root, 'entry.test.ts'))
  assert.equal(entry.answer, 42)
  assert.equal(entry.plain, 1)
  assert.deepEqual(entry.tool, { ok: true, sum: 3 })
  assert.equal(registry.require<{ ok: boolean }>(join(root, 'tool.cjs')).ok, true)
})

test('JSON, builtins, import.meta and dynamic import', async () => {
  const root = writeTree({
    'data.json': '{ "answer": 42 }\n',
    'later.ts': 'export const late = true\n',
    'entry.test.ts': [
      "import data from './data.json'",
      "import { basename } from 'node:path'",
      'export const answer: number = data.answer',
      'export const base = basename(import.meta.filename)',
      'export const url = import.meta.url',
      "export const resolved = import.meta.resolve('./later.ts')",
      "export const loadLater = () => import('./later.ts')",
      '',
    ].join('\n'),
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const entry = await registry.import<{
    answer: number
    base: string
    url: string
    resolved: string
    loadLater: () => Promise<{ late: boolean }>
  }>(join(root, 'entry.test.ts'))
  assert.equal(entry.answer, 42)
  assert.equal(entry.base, 'entry.test.ts')
  assert.equal(entry.url, `file://${join(root, 'entry.test.ts')}`)
  assert.equal(entry.resolved, `file://${join(root, 'later.ts')}`)
  assert.equal((await entry.loadLater()).late, true)
  assert.deepEqual(registry.require(join(root, 'data.json')), { answer: 42 })
})

test('import.meta has no prototype, and is one object per module', async () => {
  const root = writeTree({
    'other.ts': 'export const meta: object = import.meta\n',
    'entry.test.ts':
      "import { meta as other } from './other.ts'\nexport const meta: object = import.meta\nexport const same: boolean = meta === import.meta\nexport const distinct: boolean = meta !== other\n",
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const entry = await registry.import<{ meta: object; same: boolean; distinct: boolean }>(
    join(root, 'entry.test.ts'),
  )
  assert.equal(Object.getPrototypeOf(entry.meta), null)
  assert.equal(Object.prototype.toString.call(entry.meta), '[object Object]')
  assert.equal(entry.same, true)
  assert.equal(entry.distinct, true)
})

test('import.meta.resolve names a file that is not there, as Node does, and throws for a package', async () => {
  const root = writeTree({
    'present.ts': 'export const here = true\n',
    'entry.test.ts':
      'export const resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier)\n',
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const { resolve } = await registry.import<{ resolve: (specifier: string) => string }>(
    join(root, 'entry.test.ts'),
  )
  assert.equal(resolve('./present.ts'), `file://${join(root, 'present.ts')}`)
  assert.equal(resolve('./nope.mjs'), `file://${join(root, 'nope.mjs')}`, 'relative: no lookup')
  assert.equal(resolve('../up/nope.mjs'), `file://${join(root, '../up/nope.mjs')}`)
  assert.equal(resolve('/abs/nope.mjs'), 'file:///abs/nope.mjs', 'absolute: no lookup')
  assert.equal(resolve('file:///abs/nope.mjs'), 'file:///abs/nope.mjs')
  assert.throws(() => resolve('nope-package'), { code: 'ERR_MODULE_NOT_FOUND' })
})

test('a CommonJS file’s import() runs in the registry that evaluated it', async () => {
  // A `vm` script has no import callback, and one script serves every registry in the worker: the
  // call reaches its registry through a binding the wrapper takes.
  const root = writeTree({
    'counter.mjs': 'export let count = 0\nexport function bump() { return ++count }\n',
    'loads.cjs':
      "exports.load = (specifier) => import(specifier)\nexports.counter = () => import('./counter.mjs')\n",
    'entry.test.ts': '',
  })
  interface Loads {
    readonly load: (specifier: string) => Promise<CounterModule>
    readonly counter: () => Promise<CounterModule>
  }
  const loader = loaderFor(root)
  const open = () => loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  const first = open()
  const second = open()
  const loads = (registry: ReturnType<typeof open>): Loads =>
    registry.require<Loads>(join(root, 'loads.cjs'))

  const inFirst = await loads(first).counter()
  assert.equal(inFirst.bump(), 1)
  assert.equal(inFirst.bump(), 2)
  const inSecond = await loads(second).counter()
  assert.equal(inSecond.bump(), 1, 'the other registry has an instance of its own')
  // Called later, with a computed specifier, from the module's own directory.
  const again = await loads(first).load('./counter.mjs')
  assert.equal(again.count, 2, 'the first registry’s instance, whichever way it is reached')
  assert.equal(loader.getSourceMap(join(root, 'loads.cjs') as ModuleId)?.version, 3)
})

test('a CommonJS file with import() still loads when it returns at the top level', async () => {
  // Node wraps a CommonJS file in a function, so a top-level `return` is legal there; the runner
  // form of the file must be read as CommonJS too, not as a module (which has no such `return`).
  const root = writeTree({
    'counter.mjs': 'export let count = 0\nexport function bump() { return ++count }\n',
    'guarded.cjs':
      "exports.counter = () => import('./counter.mjs')\nif (process.argv.length >= 0) return\nexports.counter = null\n",
    'entry.test.ts': '',
  })
  const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const guarded = registry.require<{ counter: (() => Promise<CounterModule>) | null }>(
    join(root, 'guarded.cjs'),
  )
  assert.notEqual(guarded.counter, null, 'the return ended the file before the second assignment')
  assert.equal((await guarded.counter?.())?.bump(), 1)
})

test('node_modules are shared across registries, user modules are not', async () => {
  const root = writeTree({
    'node_modules/shared-esm/package.json': JSON.stringify({
      name: 'shared-esm',
      type: 'module',
      exports: './index.js',
    }),
    'node_modules/shared-esm/index.js': 'export const token = {}\n',
    'node_modules/shared-cjs/package.json': JSON.stringify({
      name: 'shared-cjs',
      main: 'index.js',
    }),
    'node_modules/shared-cjs/index.js': 'module.exports = { token: {} }\n',
    'own.ts': 'export const token = {}\n',
    'entry.test.ts':
      "import { token as esm } from 'shared-esm'\nimport cjs from 'shared-cjs'\nimport { token as own } from './own.ts'\nexport { esm, own }\nexport const cjsToken = cjs.token\n",
  })
  const loader = loaderFor(root)
  type Tokens = { esm: object; own: object; cjsToken: object }
  const load = () =>
    loader
      .createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
      .import<Tokens>(join(root, 'entry.test.ts'))
  const first = await load()
  const second = await load()
  assert.equal(first.esm, second.esm, 'ESM node_modules shared')
  assert.equal(first.cjsToken, second.cjsToken, 'CJS node_modules shared')
  assert.notEqual(first.own, second.own, 'user modules fresh')
})

test('isolateModules gets a fresh instance; resetModules drops them all', async () => {
  const root = writeTree(COUNTER)
  const registry = loaderFor(root).createFileRegistry(join(root, 'a.test.ts'), { tier: 'registry' })
  const counter = join(root, 'counter.ts')
  registry.require<CounterModule>(counter).bump()
  const inside = registry.isolateModules(() => registry.require<CounterModule>(counter).bump())
  assert.equal(inside, 1, 'isolated: fresh')
  assert.equal(registry.require<CounterModule>(counter).bump(), 2, 'outside: unchanged')
  assert.deepEqual(registry.loadedModules(), [counter])
  registry.resetModules()
  assert.equal(registry.require<CounterModule>(counter).bump(), 1, 'after reset: fresh')
  const isolatedAsync = await registry.isolateModulesAsync(async () =>
    (await registry.import<CounterModule>(counter)).bump(),
  )
  assert.equal(isolatedAsync, 1)
})

test('resetModules inside isolateModules clears every layer, and the registry works after', async () => {
  const root = writeTree(COUNTER)
  const registry = loaderFor(root).createFileRegistry(join(root, 'a.test.ts'), { tier: 'registry' })
  const counter = join(root, 'counter.ts')
  registry.require<CounterModule>(counter).bump()
  const inside = registry.isolateModules(() => {
    registry.require<CounterModule>(counter).bump()
    registry.resetModules()
    assert.deepEqual(registry.loadedModules(), [], 'every layer is empty')
    return registry.require<CounterModule>(counter).bump()
  })
  assert.equal(inside, 1, 'fresh after the reset')
  assert.equal(
    registry.require<CounterModule>(counter).bump(),
    1,
    'the outer layer was cleared too',
  )

  const isolated = await registry.isolateModulesAsync(async () => {
    registry.resetModules()
    return (await registry.import<CounterModule>(counter)).bump()
  })
  assert.equal(isolated, 1)
  assert.equal((await registry.import<CounterModule>(counter)).bump(), 1, 'cleared again')
  assert.deepEqual(registry.loadedModules(), [counter])
})

test('resetModules inside isolateModules under none leaves the worker’s shared registry working', async () => {
  const root = writeTree(COUNTER)
  const loader = loaderFor(root)
  const first = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'none' })
  first.isolateModules(() => first.resetModules())
  await first.isolateModulesAsync(async () => first.resetModules())
  const second = loader.createFileRegistry(join(root, 'b.test.ts'), { tier: 'none' })
  const b = await second.import<CounterModule>(join(root, 'b.test.ts'))
  assert.equal(b.bump(), 1, 'the next file’s registry still works')
  assert.equal(second.require<CounterModule>(join(root, 'counter.ts')).bump(), 2)
})

test('overlapping isolateModulesAsync calls each drop only their own map', async () => {
  const root = writeTree(COUNTER)
  const registry = loaderFor(root).createFileRegistry(join(root, 'a.test.ts'), { tier: 'registry' })
  const counter = join(root, 'counter.ts')
  registry.require<CounterModule>(counter).bump()

  const aReady = Promise.withResolvers<void>()
  const bReady = Promise.withResolvers<void>()
  const aGate = Promise.withResolvers<void>()
  const bGate = Promise.withResolvers<void>()
  const a = registry.isolateModulesAsync(async () => {
    const mod = await registry.import<CounterModule>(counter)
    mod.bump()
    mod.bump()
    aReady.resolve()
    await aGate.promise
    return mod.count
  })
  await aReady.promise
  const b = registry.isolateModulesAsync(async () => {
    assert.equal(
      (await registry.import<CounterModule>(counter)).bump(),
      1,
      'B has its own instance',
    )
    bReady.resolve()
    await bGate.promise
    // A has finished: B's map is still the live one, with B's instance in it.
    return (await registry.import<CounterModule>(counter)).bump()
  })
  await bReady.promise

  aGate.resolve()
  assert.equal(await a, 2, 'A kept its own instance')
  bGate.resolve()
  assert.equal(await b, 2, 'A finishing did not drop B’s map')
  assert.equal(registry.require<CounterModule>(counter).bump(), 2, 'the main map is untouched')
  assert.deepEqual(registry.loadedModules(), [counter])
})

test('failures are per file and coded', async () => {
  const root = writeTree({
    'broken.ts': 'export const = 1\n',
    'missing.test.ts': "import './nowhere.ts'\n",
    'entry.test.ts': "import './broken.ts'\n",
  })
  const loader = loaderFor(root)
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  await assert.rejects(registry.import(join(root, 'entry.test.ts')), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'LOADER_TRANSFORM_FAILED')
    assert.match(String(error), /broken\.ts:1/)
    return true
  })
  await assert.rejects(registry.import(join(root, 'missing.test.ts')), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
  assert.throws(() => loader.createFileRegistry(join(root, 'x.ts'), { tier: 'realm' }), {
    code: 'LOADER_NOT_IMPLEMENTED',
  })
  // With no module-mock registry given, nothing is mocked and registering is refused.
  assert.throws(() => registry.registerMock('./x', null, { kind: 'automock', spy: false }), {
    code: 'LOADER_NO_MODULE_MOCKS',
  })
  assert.throws(() => registry.unregisterMock('./x', null), { code: 'LOADER_NO_MODULE_MOCKS' })
})

test('compiled scripts are reported once per worker, with their maps', async () => {
  const root = writeTree(COUNTER)
  const loader = loaderFor(root)
  const events: CompiledModuleEvent[] = []
  const stop = loader.onModuleCompiled((event) => events.push(event))
  for (const name of ['a.test.ts', 'b.test.ts']) {
    await loader.createFileRegistry(join(root, name), { tier: 'registry' }).import(join(root, name))
  }
  stop()
  assert.deepEqual(events.map((event) => event.scriptUrl).sort(), [
    join(root, 'a.test.ts'),
    join(root, 'b.test.ts'),
    join(root, 'counter.ts'),
  ])
  assert.ok(events.every((event) => event.wrapperColumnOffset > 0 && !event.thirdParty))
  assert.notEqual(loader.getSourceMap(events[0]?.id ?? ('' as never)), null)
})

interface Evaluations extends Array<string> {}

/** Runs `fn` with a log the fixtures push to as they evaluate. */
async function withLog<T>(fn: (log: Evaluations) => Promise<T>): Promise<T> {
  const log: Evaluations = []
  Reflect.set(globalThis, '__invalidateLog', log)
  try {
    return await fn(log)
  } finally {
    Reflect.deleteProperty(globalThis, '__invalidateLog')
  }
}

const INVALIDATE = {
  'leaf.js': "globalThis.__invalidateLog.push('leaf')\nexport const leaf = {}\n",
  'setup.js':
    "import { leaf } from './leaf.js'\nglobalThis.__invalidateLog.push('setup')\nexport { leaf }\nexport const id = {}\n",
  'user.js': "import { id } from './setup.js'\nexport const seen = id\n",
  'cjs-setup.cjs': "globalThis.__invalidateLog.push('cjs')\nmodule.exports = { id: {} }\n",
  'entry.test.js': '',
  'other.test.js': '',
}

interface SetupModule {
  readonly leaf: object
  readonly id: object
}

for (const tier of ['none', 'registry'] as const) {
  test(`invalidate (${tier}): the module evaluates again and its dependencies keep their instances`, async () => {
    const root = writeTree(INVALIDATE)
    await withLog(async (log) => {
      const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.js'), { tier })
      const first = await registry.import<SetupModule>('./setup.js')
      const user = await registry.import<{ seen: object }>(join(root, 'user.js'))
      assert.deepEqual(log, ['leaf', 'setup'])

      registry.invalidate('./setup.js')
      const second = await registry.import<SetupModule>('./setup.js')
      assert.deepEqual(log, ['leaf', 'setup', 'setup'], 'setup ran again, leaf did not')
      assert.notEqual(second.id, first.id)
      assert.equal(second.leaf, first.leaf, 'the dependency keeps its instance')
      assert.equal(user.seen, first.id, 'an importer that already ran keeps what it imported')
      const again = await registry.import<{ seen: object }>(join(root, 'user.js'))
      assert.equal(again.seen, first.id, 'and so does its cached instance')

      // The same rule for a CommonJS module and `require()`.
      const cjs = join(root, 'cjs-setup.cjs')
      const oneCjs = registry.require<{ id: object }>(cjs)
      assert.equal(registry.require(cjs), oneCjs, 'cached until invalidated')
      registry.invalidate(cjs)
      assert.notEqual(registry.require<{ id: object }>(cjs), oneCjs)
      assert.deepEqual(log, ['leaf', 'setup', 'setup', 'cjs', 'cjs'])
    })
  })
}

test('invalidate reaches the other files of a none worker, and no other registry', async () => {
  const root = writeTree(INVALIDATE)
  await withLog(async (log) => {
    const loader = loaderFor(root)
    const file = (name: string, tier: 'none' | 'registry') =>
      loader.createFileRegistry(join(root, name), { tier })
    await file('entry.test.js', 'none').import('./setup.js')
    file('other.test.js', 'none').invalidate('./setup.js')
    await file('entry.test.js', 'none').import('./setup.js')
    assert.deepEqual(log, ['leaf', 'setup', 'setup'], 'none: one registry for the worker')

    log.length = 0
    const mine = file('entry.test.js', 'registry')
    await mine.import('./setup.js')
    file('other.test.js', 'registry').invalidate('./setup.js')
    await mine.import('./setup.js')
    assert.deepEqual(log, ['leaf', 'setup'], 'registry: the other file’s registry is its own')
  })
})

test('invalidate leaves externals, builtins, unknown and unloaded specifiers alone', async () => {
  const root = writeTree({
    ...INVALIDATE,
    'node_modules/ext/package.json': JSON.stringify({ name: 'ext', main: 'index.js' }),
    'node_modules/ext/index.js': 'module.exports = { token: {} }\n',
  })
  await withLog(async (log) => {
    const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.js'), {
      tier: 'registry',
    })
    const ext = registry.require('ext')
    await registry.import('./setup.js')
    for (const specifier of ['ext', 'node:path', 'path', './never-loaded.js', './missing.js']) {
      assert.doesNotThrow(() => registry.invalidate(specifier), specifier)
    }
    assert.equal(registry.require('ext'), ext)
    await registry.import('./setup.js')
    assert.deepEqual(log, ['leaf', 'setup'], 'nothing was evaluated again')
  })
})

test('invalidate drops a module loaded by require() whose exports differ by condition', async () => {
  const root = writeTree({
    'entry.test.js': '',
    'packages/dual/package.json': JSON.stringify({
      name: 'dual',
      exports: { '.': { import: './a.mjs', require: './a.cjs' } },
    }),
    'packages/dual/a.mjs': "globalThis.__invalidateLog.push('esm')\nexport const kind = 'esm'\n",
    'packages/dual/a.cjs':
      "globalThis.__invalidateLog.push('cjs')\nmodule.exports = { kind: {} }\n",
    'packages/cjs-only/package.json': JSON.stringify({
      name: 'cjs-only',
      exports: { '.': { require: './index.cjs' } },
    }),
    'packages/cjs-only/index.cjs':
      "globalThis.__invalidateLog.push('only')\nmodule.exports = { kind: {} }\n",
  })
  // A workspace package linked into node_modules is a user module: the resolver follows the link.
  mkdirSync(join(root, 'node_modules'))
  for (const name of ['dual', 'cjs-only']) {
    symlinkSync(join(root, 'packages', name), join(root, 'node_modules', name), 'dir')
  }
  await withLog(async (log) => {
    const registry = loaderFor(root).createFileRegistry(join(root, 'entry.test.js'), {
      tier: 'registry',
    })
    await registry.import('dual')
    const required = registry.require<{ kind: object }>('dual')
    const only = registry.require<{ kind: object }>('cjs-only')
    assert.deepEqual(log, ['esm', 'cjs', 'only'])

    registry.invalidate('dual')
    registry.invalidate('cjs-only')
    await registry.import('dual')
    assert.notEqual(registry.require<{ kind: object }>('dual'), required, 'the require() side')
    assert.notEqual(registry.require<{ kind: object }>('cjs-only'), only, 'a require-only package')
    assert.deepEqual(log, ['esm', 'cjs', 'only', 'esm', 'cjs', 'only'])
  })
})

// ---- loadedModules, per file (U5: the `deps` event reads it) ----

const CHAIN = {
  'leaf.ts': 'export const leaf: number = 1\n',
  'mid.ts': "import { leaf } from './leaf.ts'\nexport const mid: number = leaf + 1\n",
  'lonely.ts': 'export const lonely: number = 9\n',
  'a.test.ts': "import { mid } from './mid.ts'\nexport const a: number = mid\n",
  'b.test.ts': "import { mid } from './mid.ts'\nexport const b: number = mid\n",
  'c.test.ts': "import { lonely } from './lonely.ts'\nexport const c: number = lonely\n",
}

test('loadedModules: under registry it is the file’s own instances, the file and what it loaded', async () => {
  const root = writeTree(CHAIN)
  const loader = loaderFor(root)
  const a = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'registry' })
  await a.import(join(root, 'a.test.ts'))
  assert.deepEqual(a.loadedModules().toSorted(), [
    join(root, 'a.test.ts'),
    join(root, 'leaf.ts'),
    join(root, 'mid.ts'),
  ])
})

test('loadedModules: under none it is this file’s closure, not everything the worker loaded', async () => {
  const root = writeTree(CHAIN)
  const loader = loaderFor(root)
  const a = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'none' })
  await a.import(join(root, 'a.test.ts'))
  assert.deepEqual(a.loadedModules().toSorted(), [
    join(root, 'a.test.ts'),
    join(root, 'leaf.ts'),
    join(root, 'mid.ts'),
  ])
  a.dispose()

  // b.test.ts finds mid.ts (and leaf.ts under it) already evaluated: nothing is evaluated again,
  // yet they are what b loaded. a.test.ts and lonely.ts are not.
  const b = loader.createFileRegistry(join(root, 'b.test.ts'), { tier: 'none' })
  await b.import(join(root, 'b.test.ts'))
  assert.deepEqual(b.loadedModules().toSorted(), [
    join(root, 'b.test.ts'),
    join(root, 'leaf.ts'),
    join(root, 'mid.ts'),
  ])
  b.dispose()

  const c = loader.createFileRegistry(join(root, 'c.test.ts'), { tier: 'none' })
  await c.import(join(root, 'c.test.ts'))
  assert.deepEqual(c.loadedModules().toSorted(), [join(root, 'c.test.ts'), join(root, 'lonely.ts')])
})

test('loadedModules: under none a module the file imports itself counts, though an earlier file evaluated it', async () => {
  const root = writeTree(CHAIN)
  const loader = loaderFor(root)
  const a = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'none' })
  await a.import(join(root, 'a.test.ts'))
  a.dispose()

  // No new instance and no edge from a module this file evaluated: only the entry itself says so.
  const b = loader.createFileRegistry(join(root, 'b.test.ts'), { tier: 'none' })
  await b.import(join(root, 'mid.ts'))
  assert.deepEqual(b.loadedModules().toSorted(), [join(root, 'leaf.ts'), join(root, 'mid.ts')])
})

test('loadedModules: under none a reused module’s own require(variable) is still a dependency of the next file', async () => {
  const root = writeTree({
    'picked.ts': 'module.exports = { picked: true }\n',
    // `require(name)` is not a literal: no static dep names `picked.ts`, so only the load that
    // happened while this module evaluated (in the first file) says it is one of its.
    'dynamic.ts': "const name: string = './picked.ts'\nmodule.exports = { inner: require(name) }\n",
    'first.test.ts': "import dynamic from './dynamic.ts'\nexport const first: unknown = dynamic\n",
    'second.test.ts':
      "import dynamic from './dynamic.ts'\nexport const second: unknown = dynamic\n",
  })
  const loader = loaderFor(root)
  const first = loader.createFileRegistry(join(root, 'first.test.ts'), { tier: 'none' })
  await first.import(join(root, 'first.test.ts'))
  assert.deepEqual(first.loadedModules().toSorted(), [
    join(root, 'dynamic.ts'),
    join(root, 'first.test.ts'),
    join(root, 'picked.ts'),
  ])
  first.dispose()

  // dynamic.ts is found, not evaluated again, yet picked.ts is still what loading it needed.
  const second = loader.createFileRegistry(join(root, 'second.test.ts'), { tier: 'none' })
  await second.import(join(root, 'second.test.ts'))
  assert.deepEqual(second.loadedModules().toSorted(), [
    join(root, 'dynamic.ts'),
    join(root, 'picked.ts'),
    join(root, 'second.test.ts'),
  ])
})

test('loadedModules: under none a reused ES module’s own import(variable) is still a dependency of the next file', async () => {
  const root = writeTree({
    'later.ts': 'export const later: number = 3\n',
    'lazy.ts': [
      "const name: string = './later.ts'",
      'export const ready: Promise<unknown> = import(name)',
      'export const load = (): Promise<unknown> => import(name)',
      '',
    ].join('\n'),
    'first.test.ts':
      "import { ready } from './lazy.ts'\nexport const done: Promise<unknown> = ready\n",
    'second.test.ts': "import { load } from './lazy.ts'\nexport const second: unknown = load\n",
  })
  const loader = loaderFor(root)
  const first = loader.createFileRegistry(join(root, 'first.test.ts'), { tier: 'none' })
  const entry = await first.import<{ done: Promise<unknown> }>(join(root, 'first.test.ts'))
  await entry.done
  first.dispose()

  const second = loader.createFileRegistry(join(root, 'second.test.ts'), { tier: 'none' })
  await second.import(join(root, 'second.test.ts'))
  assert.deepEqual(second.loadedModules().toSorted(), [
    join(root, 'later.ts'),
    join(root, 'lazy.ts'),
    join(root, 'second.test.ts'),
  ])
})

test('loadedModules: under none a reused module’s late imports (D38) are still what the next file loaded', async () => {
  // The `mocker.mock` call hoists above the imports, so each module's own import becomes a late
  // one: never linked ahead, loaded when its call runs. One module is loaded through `import` (the
  // async wrapper) and one through `require` (the sync one).
  const root = writeTree({
    'dep-a.ts': 'export const a: number = 1\n',
    'dep-b.ts': 'export const b: number = 2\n',
    'other.ts': 'export const other: number = 3\n',
    'parent-a.ts':
      "import { a } from './dep-a.ts'\nmocker.mock('./other.ts')\nexport const seenA: number = a\n",
    'parent-b.ts':
      "import { b } from './dep-b.ts'\nmocker.mock('./other.ts')\nexport const seenB: number = b\n",
    'first.test.ts': '',
    'second.test.ts':
      "import { seenA } from './parent-a.ts'\nimport { seenB } from './parent-b.ts'\nexport const both: number = seenA + seenB\n",
  })
  const loader = loaderFor(root, {}, { hoist: HOIST, moduleScope: { names: ['mocker'] } })
  const moduleScope = (): Readonly<Record<string, unknown>> => ({ mocker: { mock: () => {} } })
  const first = loader.createFileRegistry(join(root, 'first.test.ts'), {
    tier: 'none',
    moduleScope,
  })
  await first.import(join(root, 'parent-a.ts'))
  first.require(join(root, 'parent-b.ts'))
  first.dispose()

  const second = loader.createFileRegistry(join(root, 'second.test.ts'), {
    tier: 'none',
    moduleScope,
  })
  const both = await second.import<{ both: number }>(join(root, 'second.test.ts'))
  assert.equal(both.both, 3)
  assert.deepEqual(second.loadedModules().toSorted(), [
    join(root, 'dep-a.ts'),
    join(root, 'dep-b.ts'),
    join(root, 'parent-a.ts'),
    join(root, 'parent-b.ts'),
    join(root, 'second.test.ts'),
  ])
})

/** A resolver that counts the resolutions the loader asks of it. */
function countingResolver(root: string): { readonly resolver: Resolver; resolves(): number } {
  const inner = createResolver({
    root,
    mappers: [],
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    tsconfig: false,
  })
  let count = 0
  return {
    resolver: {
      resolve: (specifier, context) => {
        count++
        return inner.resolve(specifier, context)
      },
      invalidate: (paths) => {
        inner.invalidate(paths)
      },
      fingerprint: inner.fingerprint,
    },
    resolves: () => count,
  }
}

test('loadedModules: reading a file’s closure resolves nothing: the edges are the ones linking read', async () => {
  const root = writeTree(CHAIN)
  const counting = countingResolver(root)
  const loader = loaderFor(root, {}, { resolver: counting.resolver })
  const a = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'none' })
  await a.import(join(root, 'a.test.ts'))
  const resolved = counting.resolves()
  const expected = [join(root, 'a.test.ts'), join(root, 'leaf.ts'), join(root, 'mid.ts')]
  assert.deepEqual(a.loadedModules().toSorted(), expected)
  assert.deepEqual(a.loadedModules().toSorted(), expected, 'and the same each time')
  assert.equal(counting.resolves(), resolved, 'no specifier was resolved again')
  a.dispose()

  // A later file that finds the whole chain already evaluated reads it the same way.
  const b = loader.createFileRegistry(join(root, 'b.test.ts'), { tier: 'none' })
  await b.import(join(root, 'b.test.ts'))
  const beforeRead = counting.resolves()
  assert.deepEqual(b.loadedModules().toSorted(), [
    join(root, 'b.test.ts'),
    join(root, 'leaf.ts'),
    join(root, 'mid.ts'),
  ])
  assert.equal(counting.resolves(), beforeRead, 'no specifier was resolved again')
})

test('dropRecords: the next registry reads the new code of a dropped module and shares the others', async () => {
  const root = writeTree({
    'a.ts': 'export const a = 1\n',
    'b.ts': "export const value = 'one'\n",
  })
  const loader = loaderFor(root)
  const compiled: string[] = []
  loader.onModuleCompiled((event) => compiled.push(event.id))
  const load = <T>(name: string) =>
    loader
      .createFileRegistry(join(root, 'x.test.ts'), { tier: 'registry' })
      .import<T>(join(root, name))
  assert.equal((await load<{ value: string }>('b.ts')).value, 'one')
  await load('a.ts')
  writeFileSync(join(root, 'b.ts'), "export const value = 'two'\n")
  assert.equal(
    (await load<{ value: string }>('b.ts')).value,
    'one',
    'records are kept until dropped',
  )
  loader.dropRecords([join(root, 'b.ts'), join(root, 'never-loaded.ts')])
  assert.equal((await load<{ value: string }>('b.ts')).value, 'two')
  await load('a.ts')
  assert.equal(compiled.filter((path) => path.endsWith('a.ts')).length, 1, 'a is compiled once')
})

// D127 / P42: a shared external that reads a per-file global while it first loads.

/** The per-file globals the fake watcher reports a read of, as the worker's probe does. */
const PER_FILE = ['afterEach', 'expect', 'document'] as const

/**
 * A watcher like the worker's: during an external's first native load it turns each per-file
 * global into a getter that notes the read, and puts the global back when the window closes.
 */
function probe(watched: string[]): (path: string) => (() => boolean) | null {
  return (path) => {
    watched.push(path)
    let read = false
    const saved = PER_FILE.map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    )
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) continue
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => {
          read = true
          return descriptor.value
        },
      })
    }
    return () => {
      for (const [key, descriptor] of saved) {
        if (descriptor !== undefined) Object.defineProperty(globalThis, key, descriptor)
      }
      return read
    }
  }
}

const HOOKING = {
  // Registers a test hook as it loads, through a module of its own (its closure).
  'node_modules/hooks-ext/package.json': JSON.stringify({ name: 'hooks-ext', main: 'index.js' }),
  'node_modules/hooks-ext/index.js':
    "const dep = require('./dep.js')\nafterEach(() => {})\nmodule.exports = { token: {}, dep }\n",
  'node_modules/hooks-ext/dep.js': 'module.exports = { token: {} }\n',
  // Reads `expect` as it loads.
  'node_modules/expect-ext/package.json': JSON.stringify({ name: 'expect-ext', main: 'index.js' }),
  'node_modules/expect-ext/index.js': 'module.exports = { token: {}, expect: expect }\n',
  // Reads the environment's `document` as it loads.
  'node_modules/dom-ext/package.json': JSON.stringify({ name: 'dom-ext', main: 'index.js' }),
  'node_modules/dom-ext/index.js': 'module.exports = { token: {}, document: document }\n',
  // Reads nothing per file.
  'node_modules/plain-ext/package.json': JSON.stringify({ name: 'plain-ext', main: 'index.js' }),
  'node_modules/plain-ext/index.js': 'module.exports = { token: {} }\n',
  'a.test.js':
    "module.exports = { hooks: require('hooks-ext'), expect: require('expect-ext'), dom: require('dom-ext'), plain: require('plain-ext') }\n",
  'b.test.js':
    "module.exports = { hooks: require('hooks-ext'), expect: require('expect-ext'), dom: require('dom-ext'), plain: require('plain-ext') }\n",
}

interface Loaded {
  readonly hooks: { readonly token: object; readonly dep: { readonly token: object } }
  readonly expect: { readonly token: object; readonly expect: object }
  readonly dom: { readonly token: object; readonly document: object }
  readonly plain: { readonly token: object }
}

/** Runs `fn` with the per-file globals installed as one file would see them, then removes them. */
async function withFileGlobals<T>(
  fn: (globals: { hooks: number; expect: object; document: object }) => Promise<T>,
): Promise<T> {
  const globals = { hooks: 0, expect: {}, document: {} }
  Object.assign(globalThis, {
    afterEach: () => {
      globals.hooks++
    },
    expect: globals.expect,
    document: globals.document,
  })
  try {
    return await fn(globals)
  } finally {
    for (const key of PER_FILE) Reflect.deleteProperty(globalThis, key)
  }
}

test('reevaluateHookingExternals: an external that reads a per-file global as it loads is evaluated again in each later file', async () => {
  const root = writeTree(HOOKING)
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  const watched: string[] = []
  loader.watchExternalLoads(probe(watched))
  const load = (name: string) =>
    loader
      .createFileRegistry(join(root, name), { tier: 'registry' })
      .import<Loaded>(join(root, name))
  await withFileGlobals(async (globals) => {
    const first = await load('a.test.js')
    assert.deepEqual(
      watched.map((path) => path.slice(root.length + 1)).toSorted(),
      [
        'node_modules/dom-ext/index.js',
        'node_modules/expect-ext/index.js',
        'node_modules/hooks-ext/index.js',
        'node_modules/plain-ext/index.js',
      ],
      'each external’s first native load is one window; hooks-ext’s own dep is part of its window',
    )
    assert.equal(globals.hooks, 1)
    assert.deepEqual(
      loader
        .takeLearnedExternals()
        .map((path) => path.slice(root.length + 1))
        .toSorted(),
      [
        'node_modules/dom-ext/index.js',
        'node_modules/expect-ext/index.js',
        'node_modules/hooks-ext/dep.js',
        'node_modules/hooks-ext/index.js',
      ],
      'learned: the three that read a per-file global, and the file hooks-ext’s load evaluated',
    )
    assert.deepEqual(loader.takeLearnedExternals(), [], 'each is handed out once')
    const second = await load('b.test.js')
    assert.equal(globals.hooks, 2, 'the second file registers the hook again')
    assert.notEqual(second.hooks.token, first.hooks.token, 'hooks-ext is the second file’s own')
    assert.notEqual(second.hooks.dep.token, first.hooks.dep.token, 'and so is its closure')
    assert.notEqual(second.expect.token, first.expect.token)
    assert.notEqual(second.dom.token, first.dom.token)
    assert.equal(
      second.plain.token,
      first.plain.token,
      'an external that reads nothing stays shared',
    )
    assert.equal(watched.length, 4, 'nothing is watched once every external has loaded')
  })
})

test('reevaluateHookingExternals: a learned set given to a new loader inlines from its first file', async () => {
  const root = writeTree(HOOKING)
  const policy = { reevaluateHookingExternals: true, interopDefault: 'babel' } as const
  const learning = loaderFor(root, policy)
  learning.watchExternalLoads(probe([]))
  await withFileGlobals(async () => {
    await learning
      .createFileRegistry(join(root, 'a.test.js'), { tier: 'registry' })
      .import(join(root, 'a.test.js'))
  })
  const learned = learning.takeLearnedExternals()
  learning[Symbol.dispose]()

  const loader = loaderFor(root, policy)
  const watched: string[] = []
  loader.watchExternalLoads(probe(watched))
  loader.reevaluateExternals(learned)
  await withFileGlobals(async (globals) => {
    const first = await loader
      .createFileRegistry(join(root, 'a.test.js'), { tier: 'registry' })
      .import<Loaded>(join(root, 'a.test.js'))
    assert.equal(globals.hooks, 1)
    assert.deepEqual(
      watched.map((path) => path.slice(root.length + 1)),
      ['node_modules/plain-ext/index.js'],
      'only the external the set does not name loads natively',
    )
    const second = await loader
      .createFileRegistry(join(root, 'b.test.js'), { tier: 'registry' })
      .import<Loaded>(join(root, 'b.test.js'))
    assert.equal(globals.hooks, 2)
    assert.notEqual(second.hooks.token, first.hooks.token)
    assert.deepEqual(
      loader.takeLearnedExternals(),
      [],
      'a seeded set is the caller’s own: none of it is handed back as learned',
    )
  })
})

test('reevaluateHookingExternals off (neutral): nothing is watched or inlined, every external is shared', async () => {
  const root = writeTree(HOOKING)
  const loader = loaderFor(root, { interopDefault: 'babel' })
  const watched: string[] = []
  loader.watchExternalLoads(probe(watched))
  loader.reevaluateExternals([join(root, 'node_modules/hooks-ext/index.js')])
  await withFileGlobals(async (globals) => {
    const load = (name: string) =>
      loader
        .createFileRegistry(join(root, name), { tier: 'registry' })
        .import<Loaded>(join(root, name))
    const first = await load('a.test.js')
    const second = await load('b.test.js')
    assert.deepEqual(watched, [])
    assert.deepEqual(loader.takeLearnedExternals(), [])
    assert.equal(globals.hooks, 1, 'the hook is registered by the first file only')
    assert.equal(second.hooks.token, first.hooks.token)
    assert.equal(second.dom.token, first.dom.token)
  })
})

test('reevaluateHookingExternals: a watcher that throws as it opens still has the windows before it closed', async () => {
  const root = writeTree(HOOKING)
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  loader.watchExternalLoads(probe([]))
  loader.watchExternalLoads(() => {
    throw new Error('watcher broke')
  })
  await withFileGlobals(async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'afterEach')
    await assert.rejects(
      loader
        .createFileRegistry(join(root, 'a.test.js'), { tier: 'registry' })
        .import(join(root, 'a.test.js')),
      /watcher broke/,
    )
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, 'afterEach'),
      before,
      'the first watcher’s accessor is gone',
    )
  })
})

test('reevaluateHookingExternals: every window ends even when one end throws, and the load’s value stands learned', async () => {
  const root = writeTree(HOOKING)
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  loader.watchExternalLoads(() => () => {
    throw new Error('end broke')
  })
  loader.watchExternalLoads(probe([]))
  await withFileGlobals(async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'afterEach')
    await assert.rejects(
      loader
        .createFileRegistry(join(root, 'a.test.js'), { tier: 'registry' })
        .import(join(root, 'a.test.js')),
      /end broke/,
    )
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'afterEach'), before)
    assert.ok(
      loader.takeLearnedExternals().some((path) => path.endsWith('hooks-ext/index.js')),
      'the other watcher’s answer still counts',
    )
  })
})

test('reevaluateHookingExternals: a load that throws after a per-file read is learned, and is not watched again', async () => {
  const root = writeTree({
    'node_modules/throws-ext/package.json': JSON.stringify({
      name: 'throws-ext',
      main: 'index.js',
    }),
    'node_modules/throws-ext/index.js':
      "afterEach(() => {})\nthrow new Error('throws-ext failed')\n",
    'a.test.js': "require('throws-ext')\n",
    'b.test.js': "require('throws-ext')\n",
  })
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  const watched: string[] = []
  loader.watchExternalLoads(probe(watched))
  await withFileGlobals(async (globals) => {
    const load = (name: string) =>
      loader.createFileRegistry(join(root, name), { tier: 'registry' }).import(join(root, name))
    await assert.rejects(load('a.test.js'), /throws-ext failed/)
    assert.deepEqual(
      loader.takeLearnedExternals().map((path) => path.slice(root.length + 1)),
      ['node_modules/throws-ext/index.js'],
    )
    await assert.rejects(load('b.test.js'), /throws-ext failed/)
    assert.equal(watched.length, 1, 'the second file evaluates it through its registry')
    assert.equal(globals.hooks, 2)
  })
})

test('reevaluateHookingExternals under isolation none: a no-op, as the shared registry keeps what it loaded', async () => {
  const root = writeTree(HOOKING)
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  loader.watchExternalLoads(probe([]))
  await withFileGlobals(async (globals) => {
    const load = (name: string) =>
      loader.createFileRegistry(join(root, name), { tier: 'none' }).import<Loaded>(join(root, name))
    const first = await load('a.test.js')
    const second = await load('b.test.js')
    assert.equal(globals.hooks, 1, 'the hook is registered by the first file only')
    assert.equal(second.hooks.token, first.hooks.token, 'hooks-ext stays the worker’s one copy')
  })
})

// A `react`-like singleton learned through an RTL-like external, and a component library that
// requires it at load and reads no per-file global: the library must see the file's singleton.
const SINGLETON = {
  'node_modules/singleton/package.json': JSON.stringify({ name: 'singleton', main: 'index.js' }),
  'node_modules/singleton/index.js':
    ';(globalThis.__provinoSingletonEvals ??= []).push(__filename)\nmodule.exports = { token: {} }\n',
  'node_modules/rtl-ext/package.json': JSON.stringify({ name: 'rtl-ext', main: 'index.js' }),
  'node_modules/rtl-ext/index.js':
    "const singleton = require('singleton')\nafterEach(() => {})\nmodule.exports = { singleton }\n",
  'node_modules/lib-ext/package.json': JSON.stringify({ name: 'lib-ext', main: 'index.js' }),
  'node_modules/lib-ext/index.js': "module.exports = { singleton: require('singleton') }\n",
  'a.test.js':
    "module.exports = { rtl: require('rtl-ext'), lib: require('lib-ext'), singleton: require('singleton') }\n",
  'b.test.js':
    "module.exports = { lib: require('lib-ext'), rtl: require('rtl-ext'), singleton: require('singleton') }\n",
}

interface SingletonLoaded {
  readonly rtl: { readonly singleton: { readonly token: object } }
  readonly lib: { readonly singleton: { readonly token: object } }
  readonly singleton: { readonly token: object }
}

/** How many times the singleton under `root` was evaluated since the last call. */
function singletonEvals(root: string): number {
  const all = Reflect.get(globalThis, '__provinoSingletonEvals') as string[] | undefined
  const count = (all ?? []).filter((path) => path.startsWith(root)).length
  Reflect.set(globalThis, '__provinoSingletonEvals', [])
  return count
}

test('reevaluateHookingExternals: a shared external that requires a learned one is inlined, so it sees the file’s instance', async () => {
  const root = realpathSync(writeTree(SINGLETON))
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  loader.watchExternalLoads(probe([]))
  const load = (name: string) =>
    loader
      .createFileRegistry(join(root, name), { tier: 'registry' })
      .require<SingletonLoaded>(join(root, name))
  await withFileGlobals(async () => {
    singletonEvals(root)
    const first = load('a.test.js')
    assert.equal(singletonEvals(root), 1)
    assert.equal(first.lib.singleton, first.singleton)
    assert.ok(
      loader.takeLearnedExternals().some((path) => path.endsWith('singleton/index.js')),
      'the singleton is learned through rtl-ext’s window',
    )
    const second = load('b.test.js')
    assert.equal(singletonEvals(root), 1, 'evaluated once in the second file')
    assert.notEqual(second.singleton.token, first.singleton.token, 'the second file’s own')
    assert.equal(second.lib.singleton, second.singleton, 'the library sees the file’s singleton')
    assert.equal(second.rtl.singleton, second.singleton)
  })
})

test('reevaluateHookingExternals: a seeded set inlines a library that requires a learned external, so it is evaluated once per file', async () => {
  const root = realpathSync(writeTree(SINGLETON))
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  loader.watchExternalLoads(probe([]))
  loader.reevaluateExternals([
    join(root, 'node_modules/rtl-ext/index.js'),
    join(root, 'node_modules/singleton/index.js'),
  ])
  const load = (name: string) =>
    loader
      .createFileRegistry(join(root, name), { tier: 'registry' })
      .require<SingletonLoaded>(join(root, name))
  await withFileGlobals(async () => {
    singletonEvals(root)
    for (const name of ['a.test.js', 'b.test.js']) {
      const loaded = load(name)
      assert.equal(singletonEvals(root), 1, `evaluated once in ${name}`)
      assert.equal(loaded.lib.singleton, loaded.singleton)
      assert.equal(loaded.rtl.singleton, loaded.singleton)
    }
  })
})

/**
 * D132: a per-file package (`plugin`, which reads `document` as it loads) registers into a package
 * it reaches through a re-export barrel (`registry`, which throws on a duplicate id), and shares a
 * dependency with a shared package (`core-lib`, also imported by `widget`). `late` is a shared
 * importer of the registry that only the third file loads.
 */
const CLOSURE = {
  'node_modules/registry/package.json': JSON.stringify({ name: 'registry', main: 'index.js' }),
  'node_modules/registry/index.js': [
    ';(globalThis.__provinoClosureEvals ??= []).push(__filename)',
    'const ids = new Map()',
    'class Entry {}',
    'function register(id, entry) {',
    "  if (ids.has(id)) throw new RangeError('Duplicate use of id ' + id)",
    '  ids.set(id, entry)',
    '  return entry',
    '}',
    'module.exports = { Entry, register, lookup: (id) => ids.get(id) }',
    '',
  ].join('\n'),
  'node_modules/registry-barrel/package.json': JSON.stringify({
    name: 'registry-barrel',
    main: 'index.js',
  }),
  'node_modules/registry-barrel/index.js': "module.exports = require('registry')\n",
  'node_modules/dom-reader/package.json': JSON.stringify({ name: 'dom-reader', main: 'index.js' }),
  'node_modules/dom-reader/index.js': 'module.exports = { document: document }\n',
  'node_modules/core-lib/package.json': JSON.stringify({ name: 'core-lib', main: 'index.js' }),
  'node_modules/core-lib/index.js':
    ';(globalThis.__provinoClosureEvals ??= []).push(__filename)\nmodule.exports = { token: {} }\n',
  'node_modules/plugin/package.json': JSON.stringify({ name: 'plugin', main: 'index.js' }),
  'node_modules/plugin/index.js': [
    "const registry = require('registry-barrel')",
    "require('dom-reader')",
    "const core = require('core-lib')",
    'class PluginEntry extends registry.Entry {}',
    "module.exports = { entry: registry.register('plugin', new PluginEntry()), registry, core }",
    '',
  ].join('\n'),
  'node_modules/widget/package.json': JSON.stringify({ name: 'widget', main: 'index.js' }),
  'node_modules/widget/index.js': "module.exports = { core: require('core-lib') }\n",
  'node_modules/late/package.json': JSON.stringify({ name: 'late', main: 'index.js' }),
  'node_modules/late/index.js': "module.exports = { registry: require('registry') }\n",
  'a.test.js':
    "module.exports = { registry: require('registry'), widget: require('widget'), plugin: require('plugin') }\n",
  'b.test.js':
    "module.exports = { registry: require('registry'), widget: require('widget'), plugin: require('plugin') }\n",
  'c.test.js':
    "module.exports = { registry: require('registry'), widget: require('widget'), plugin: require('plugin'), late: require('late') }\n",
}

interface Registry {
  readonly Entry: abstract new () => object
  readonly lookup: (id: string) => object | undefined
}

interface ClosureLoaded {
  readonly registry: Registry
  readonly widget: { readonly core: { readonly token: object } }
  readonly plugin: {
    readonly entry: object
    readonly registry: Registry
    readonly core: { readonly token: object }
  }
  readonly late?: { readonly registry: Registry }
}

/** The packages under `root` evaluated since the last call, by name, in order. */
function closureEvals(root: string): string[] {
  const all = Reflect.get(globalThis, '__provinoClosureEvals') as string[] | undefined
  Reflect.set(globalThis, '__provinoClosureEvals', [])
  return (all ?? [])
    .filter((path) => path.startsWith(root))
    .map((path) => path.slice(root.length + '/node_modules/'.length).split('/')[0] ?? '')
}

function closureLoader(root: string): (name: string) => ClosureLoaded {
  const loader = loaderFor(root, { reevaluateHookingExternals: true, interopDefault: 'babel' })
  loader.watchExternalLoads(probe([]))
  return (name) =>
    loader
      .createFileRegistry(join(root, name), { tier: 'registry' })
      .require<ClosureLoaded>(join(root, name))
}

test('reevaluateHookingExternals (D132): a dependency only per-file packages import is evaluated per file, through a re-export', async () => {
  const root = writeTree(CLOSURE)
  const load = closureLoader(root)
  await withFileGlobals(async () => {
    closureEvals(root)
    const first = load('a.test.js')
    assert.deepEqual(closureEvals(root), ['registry', 'core-lib'])
    for (const name of ['b.test.js', 'c.test.js']) {
      const loaded = load(name)
      assert.ok(closureEvals(root).includes('registry'), `the registry is ${name}’s own`)
      assert.notEqual(loaded.registry, first.registry)
      assert.equal(loaded.plugin.registry, loaded.registry, 'the plugin writes into it')
      assert.equal(loaded.registry.lookup('plugin'), loaded.plugin.entry, 'registered once')
      assert.ok(loaded.plugin.entry instanceof loaded.registry.Entry)
    }
  })
})

test('reevaluateHookingExternals (D132): a dependency a shared package imports too stays shared', async () => {
  const root = writeTree(CLOSURE)
  const load = closureLoader(root)
  await withFileGlobals(async () => {
    closureEvals(root)
    const first = load('a.test.js')
    const second = load('b.test.js')
    assert.deepEqual(
      closureEvals(root).filter((name) => name === 'core-lib'),
      ['core-lib'],
      'core-lib is evaluated once per worker',
    )
    assert.equal(second.widget.core, first.widget.core, 'widget stays shared')
    assert.equal(second.plugin.core, second.widget.core, 'the per-file plugin sees the shared one')
    assert.notEqual(second.plugin.entry, first.plugin.entry, 'the plugin itself is per file')
  })
})

test('reevaluateHookingExternals (D132): a worker seeded with what a cold one learned and loaded natively has its instances; seeded with the learned set alone, the whole closure', async () => {
  const policy = { reevaluateHookingExternals: true, interopDefault: 'babel' } as const
  /** What a run on a fresh copy of the tree (Node's own cache is the process's) did, by file. */
  interface Run {
    readonly root: string
    readonly results: readonly ClosureLoaded[]
    readonly learned: readonly string[]
    readonly loaded: readonly string[]
    readonly coreLoads: readonly string[]
  }
  /**
   * Runs two files on a new loader over a new copy of the tree, seeded with `from`'s learned set
   * (and its native loads, with `loaded`) carried over as the results cache carries them, relative
   * to the root. What the loader learned and loaded is taken after each file, as the worker does.
   */
  const run = (from?: Run, loaded = false): Run => {
    const root = writeTree(CLOSURE)
    const moved = (paths: readonly string[]) =>
      paths.map((path) => join(root, path.slice((from?.root.length ?? 0) + 1)))
    const loader = loaderFor(root, policy)
    loader.watchExternalLoads(probe([]))
    if (from !== undefined) {
      loader.reevaluateExternals(moved(from.learned), loaded ? moved(from.loaded) : undefined)
    }
    const learnedNow: string[] = []
    const loadedNow: string[] = []
    closureEvals(root)
    const results = ['a.test.js', 'b.test.js'].map((name) => {
      const result = loader
        .createFileRegistry(join(root, name), { tier: 'registry' })
        .require<ClosureLoaded>(join(root, name))
      learnedNow.push(...loader.takeLearnedExternals())
      loadedNow.push(...loader.takeLoadedExternals())
      return result
    })
    const coreLoads = closureEvals(root).filter((name) => name === 'core-lib')
    loader[Symbol.dispose]()
    return { root, results, learned: learnedNow, loaded: loadedNow, coreLoads }
  }
  await withFileGlobals(async () => {
    const cold = run()
    assert.deepEqual(
      cold.loaded.map((path) => path.slice(cold.root.length + 1)).toSorted(),
      [
        'node_modules/core-lib/index.js',
        'node_modules/registry/index.js',
        'node_modules/widget/index.js',
      ],
      'what the tests and the per-file plugin required natively, less the plugin it learned',
    )
    assert.deepEqual(cold.coreLoads, ['core-lib'], 'cold: core-lib is evaluated once per worker')

    const warm = run(cold, true)
    assert.deepEqual(warm.coreLoads, ['core-lib'], 'warm: so it is here')
    const [first, second] = warm.results
    assert.ok(first !== undefined && second !== undefined)
    assert.equal(second.widget.core, first.widget.core, 'widget stays shared')
    assert.equal(second.plugin.core, second.widget.core, 'the per-file plugin sees the shared one')
    assert.notEqual(second.plugin.entry, first.plugin.entry, 'the plugin is per file')
    assert.notEqual(second.registry, first.registry, 'and so is the registry it writes into')
    assert.deepEqual(warm.learned, [], 'nothing new is learned')

    // A results cache written before the list was kept: the seeds join before any file loaded
    // `widget`, so core-lib joins with them and `widget` follows by reach.
    const bare = run(cold)
    assert.deepEqual(bare.coreLoads, ['core-lib', 'core-lib'], 'core-lib is evaluated in each file')
    const [bareFirst, bareSecond] = bare.results
    assert.notEqual(bareSecond?.widget.core, bareFirst?.widget.core, 'widget is per file too')
  })
})

test('reevaluateHookingExternals (D132): a shared importer of a per-file dependency, seen later, is inlined too', async () => {
  const root = writeTree(CLOSURE)
  const load = closureLoader(root)
  await withFileGlobals(async () => {
    load('a.test.js')
    load('b.test.js')
    const third = load('c.test.js')
    assert.equal(third.late?.registry, third.registry, 'late shares the file’s registry')
    const fourth = load('c.test.js')
    assert.equal(fourth.late?.registry, fourth.registry, 'and the registry stays per file')
    assert.equal(fourth.registry.lookup('plugin'), fourth.plugin.entry)
  })
})

/** A module-level registry that refuses an id it already holds, as a package's `index.js`. */
const REGISTRY_SOURCE = [
  'const ids = new Map()',
  'exports.register = (id, entry) => {',
  "  if (ids.has(id)) throw new RangeError('Duplicate use of id ' + id)",
  '  ids.set(id, entry)',
  '  return entry',
  '}',
  '',
].join('\n')

/** A package named `name` whose `main` is `index.js` with `source`. */
function pkg(name: string, source: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, main: 'index.js' }),
    [`node_modules/${name}/index.js`]: source,
  }
}

interface SeededLoader {
  readonly load: <T>(name: string) => T
  readonly warnings: LoaderWarning[]
}

/** A loader with D132 on, its set seeded with `seeds` (paths under `root`), and its warnings. */
function seededLoader(
  root: string,
  seeds: readonly string[],
  extra: Omit<LoaderOptionsExtra, 'policy'> = {},
  fileScope?: () => Readonly<Record<string, unknown>>,
): SeededLoader {
  const warnings: LoaderWarning[] = []
  const loader = createLoader({
    ...loaderOptionsFor(root, {
      ...extra,
      policy: { reevaluateHookingExternals: true, interopDefault: 'babel' },
    }),
    onWarning: (warning) => {
      warnings.push(warning)
    },
  })
  loader.reevaluateExternals(seeds.map((seed) => join(root, seed)))
  return {
    warnings,
    load: <T>(name: string): T =>
      loader
        .createFileRegistry(join(root, name), {
          tier: 'registry',
          ...(fileScope === undefined ? {} : { moduleScope: fileScope }),
        })
        .require<T>(join(root, name)),
  }
}

interface MidFile {
  readonly x: { readonly d: object }
  readonly q: { readonly x: { readonly d: object } }
  readonly d: object
}

const MID_FILE_TEST =
  "const x = require('x')\nconst q = require('q')\nmodule.exports = { x, q, d: require('d') }\n"

test('reevaluateHookingExternals (D132): a dependency that joins partway through a file joins from the next file, never beside the native copy', () => {
  // `x` is shared when the file loads it, so Node loads `d` with it. `q`, seen only later in the
  // file, imports the seed `p` and `x`, so `x` and `d` join the set; this file keeps Node's copies.
  const root = writeTree({
    ...pkg('p', 'module.exports = {}\n'),
    ...pkg('d', 'module.exports = {}\n'),
    ...pkg('x', "module.exports = { d: require('d') }\n"),
    ...pkg('q', "require('p')\nmodule.exports = { x: require('x') }\n"),
    'a.test.js': MID_FILE_TEST,
    'b.test.js': MID_FILE_TEST,
  })
  const { load } = seededLoader(root, ['node_modules/p/index.js'])
  const first = load<MidFile>('a.test.js')
  assert.equal(first.q.x, first.x, 'q gets the file’s x')
  assert.equal(first.d, first.x.d, 'one copy of d in the file')
  const second = load<MidFile>('b.test.js')
  assert.notEqual(second.x, first.x, 'x is per file from the next file on')
  assert.equal(second.q.x, second.x)
  assert.equal(second.d, second.x.d, 'one copy of d in the next file')
  assert.notEqual(second.d, first.d, 'and it is that file’s own')
})

test('reevaluateHookingExternals (D132): a claimed seed found partway through a file joins its dependencies from the next file', () => {
  // `q`'s entry is a `.ts` file the transforms make a user module (a seed, D130). The file asks
  // for it by a computed name, so it is found only when that line runs, after `x` (and Node's `d`
  // with it) loaded natively; a static `require('q')` would find it when the file is linked.
  const test =
    "const x = require('x')\nconst q = require(['q'].join(''))\nmodule.exports = { x, q, d: require('d') }\n"
  const root = writeTree({
    ...pkg('d', 'module.exports = {}\n'),
    ...pkg('x', "module.exports = { d: require('d') }\n"),
    'node_modules/q/package.json': JSON.stringify({ name: 'q', main: 'index.ts' }),
    'node_modules/q/index.ts': "module.exports = { x: require('x') }\n",
    'a.test.js': test,
    'b.test.js': test,
  })
  const { load } = seededLoader(root, [], {
    transformClaims: { patterns: ['\\.ts$'], ignorePatterns: [] },
  })
  const first = load<MidFile>('a.test.js')
  assert.equal(first.q.x, first.x, 'the claimed file gets the file’s x')
  assert.equal(first.d, first.x.d, 'one copy of d in the file')
  const second = load<MidFile>('b.test.js')
  assert.equal(second.q.x, second.x)
  assert.equal(second.d, second.x.d, 'one copy of d in the next file')
  assert.notEqual(second.d, first.d, 'and it is that file’s own')
})

interface Registered {
  readonly entry: object
}

test('reevaluateHookingExternals (D132): a registry whose files import each other joins with the per-file package that writes into it', () => {
  const root = writeTree({
    ...pkg('plugin', "module.exports = { entry: require('reg').register('plugin', {}) }\n"),
    'node_modules/reg/package.json': JSON.stringify({ name: 'reg', main: 'index.js' }),
    'node_modules/reg/index.js': `${REGISTRY_SOURCE}exports.a = require('./a.js')\n`,
    'node_modules/reg/a.js': "exports.index = require('./index.js')\n",
    'a.test.js': "module.exports = require('plugin')\n",
    'b.test.js': "module.exports = require('plugin')\n",
    'c.test.js': "module.exports = require('plugin')\n",
  })
  const { load } = seededLoader(root, ['node_modules/plugin/index.js'])
  const entries = ['a.test.js', 'b.test.js', 'c.test.js'].map((name) => load<Registered>(name))
  assert.equal(new Set(entries.map(({ entry }) => entry)).size, 3, 'one registration per file')
})

test('reevaluateHookingExternals (D132): an importer inlined for a served module does not keep a registry shared', () => {
  // `served-user` is inlined in every file for its `@jest/globals`, so it never holds Node's copy.
  const root = writeTree({
    ...pkg('@jest/globals', "throw new Error('not outside Jest')\n"),
    ...pkg('served-user', "require('@jest/globals')\nmodule.exports = { reg: require('reg') }\n"),
    ...pkg(
      'plugin',
      "const reg = require('reg')\nmodule.exports = { reg, entry: reg.register('plugin', {}) }\n",
    ),
    ...pkg('reg', REGISTRY_SOURCE),
    'a.test.js': "module.exports = { served: require('served-user'), plugin: require('plugin') }\n",
    'b.test.js': "module.exports = { served: require('served-user'), plugin: require('plugin') }\n",
  })
  const { load } = seededLoader(
    root,
    ['node_modules/plugin/index.js'],
    { moduleScope: { names: [], modules: ['@jest/globals'] } },
    () => ({ '@jest/globals': {} }),
  )
  type Loaded = { served: { reg: object }; plugin: { reg: object; entry: object } }
  const first = load<Loaded>('a.test.js')
  const second = load<Loaded>('b.test.js')
  assert.equal(second.served.reg, second.plugin.reg, 'one registry in the file')
  assert.notEqual(second.plugin.entry, first.plugin.entry, 'registered once per file')
})

/** Writes `workspace/ws-lib` (which requires `reg`) and links it into the tree's node_modules. */
function linkWorkspacePackage(root: string): void {
  mkdirSync(join(root, 'workspace/ws-lib'), { recursive: true })
  writeFileSync(
    join(root, 'workspace/ws-lib/package.json'),
    JSON.stringify({ name: 'ws-lib', main: 'index.js' }),
  )
  writeFileSync(
    join(root, 'workspace/ws-lib/index.js'),
    "module.exports = { reg: require('reg') }\n",
  )
  symlinkSync(join(root, 'workspace/ws-lib'), join(root, 'node_modules/ws-lib'))
  // It finds `reg` from the project's node_modules, as a hoisted workspace does.
  symlinkSync(join(root, 'node_modules'), join(root, 'workspace/node_modules'))
}

test('reevaluateHookingExternals (D132): a workspace package between a per-file package and a registry joins when only per-file packages load it', () => {
  const root = writeTree({
    ...pkg(
      'plugin',
      "const ws = require('ws-lib')\nmodule.exports = { reg: ws.reg, entry: ws.reg.register('plugin', {}) }\n",
    ),
    ...pkg('reg', REGISTRY_SOURCE),
    'a.test.js': "module.exports = require('plugin')\n",
    'b.test.js': "module.exports = require('plugin')\n",
  })
  linkWorkspacePackage(root)
  const { load } = seededLoader(root, ['node_modules/plugin/index.js'])
  const first = load<Registered & { reg: object }>('a.test.js')
  const second = load<Registered & { reg: object }>('b.test.js')
  assert.notEqual(second.reg, first.reg, 'the registry is the file’s own')
  assert.notEqual(second.entry, first.entry)
})

test('reevaluateHookingExternals (D132): a workspace package a shared package also loads is Node’s copy, so the registry below it stays shared', () => {
  const root = writeTree({
    ...pkg('plugin', "module.exports = { reg: require('ws-lib').reg }\n"),
    ...pkg('shared-user', "module.exports = { reg: require('ws-lib').reg }\n"),
    ...pkg('reg', REGISTRY_SOURCE),
    'a.test.js': "module.exports = { shared: require('shared-user'), plugin: require('plugin') }\n",
    'b.test.js': "module.exports = { shared: require('shared-user'), plugin: require('plugin') }\n",
  })
  linkWorkspacePackage(root)
  const { load } = seededLoader(root, ['node_modules/plugin/index.js'])
  type Loaded = { shared: { reg: object }; plugin: { reg: object } }
  const first = load<Loaded>('a.test.js')
  const second = load<Loaded>('b.test.js')
  assert.equal(second.shared.reg, first.shared.reg, 'the shared package keeps the worker’s copy')
  assert.equal(second.plugin.reg, second.shared.reg, 'and the plugin sees the same one')
})

test('reevaluateHookingExternals (D132): a dependency a shared package could load by a computed require stays shared, with a debug warning', () => {
  const root = writeTree({
    ...pkg('plugin', "module.exports = { reg: require('reg') }\n"),
    ...pkg('reg', 'module.exports = {}\n'),
    'node_modules/loads-by-name/package.json': JSON.stringify({
      name: 'loads-by-name',
      main: 'index.js',
      dependencies: { reg: '1.0.0' },
    }),
    'node_modules/loads-by-name/index.js':
      "const name = ['r', 'e', 'g'].join('')\nmodule.exports = { reg: require(name) }\n",
    'a.test.js':
      "module.exports = { dynamic: require('loads-by-name'), plugin: require('plugin') }\n",
    'b.test.js':
      "module.exports = { dynamic: require('loads-by-name'), plugin: require('plugin') }\n",
  })
  const { load, warnings } = seededLoader(root, ['node_modules/plugin/index.js'])
  type Loaded = { dynamic: { reg: object }; plugin: { reg: object } }
  load<Loaded>('a.test.js')
  const second = load<Loaded>('b.test.js')
  assert.equal(second.plugin.reg, second.dynamic.reg, 'one copy of reg in the file')
  assert.ok(
    warnings.some(
      (warning) =>
        warning.code === 'PROVINO_INLINE_DYNAMIC' &&
        warning.message.includes(join(root, 'node_modules/reg/index.js')),
    ),
    'the refused join is reported',
  )
})

test('isolation none: an external inlined for a served module is evaluated once per worker, not again per file', () => {
  const root = writeTree({
    'node_modules/@jest/globals/package.json': JSON.stringify({
      name: '@jest/globals',
      main: 'index.js',
    }),
    'node_modules/@jest/globals/index.js': "throw new Error('not outside Jest')\n",
    'node_modules/uses-globals/package.json': JSON.stringify({
      name: 'uses-globals',
      main: 'index.js',
    }),
    'node_modules/uses-globals/index.js':
      ";(globalThis.__provinoServedEvals ??= []).push(__filename)\nmodule.exports = { served: require('@jest/globals').marker, token: {} }\n",
    'a.test.js': "module.exports = require('uses-globals')\n",
    'b.test.js': "module.exports = require('uses-globals')\n",
  })
  const loader = loaderFor(
    root,
    { interopDefault: 'babel' },
    { moduleScope: { names: [], modules: ['@jest/globals'] } },
  )
  const marker = {}
  Reflect.set(globalThis, '__provinoServedEvals', [])
  const load = (name: string) => {
    const registry = loader.createFileRegistry(join(root, name), {
      tier: 'none',
      moduleScope: () => ({ '@jest/globals': { marker } }),
    })
    const value = registry.require<{ served: object; token: object }>(join(root, name))
    registry.dispose()
    return value
  }
  const first = load('a.test.js')
  const second = load('b.test.js')
  assert.equal(first.served, marker)
  assert.equal(second.token, first.token, 'the worker’s one copy')
  const evals = Reflect.get(globalThis, '__provinoServedEvals') as string[]
  assert.equal(evals.length, 1, 'evaluated once under none')
})

test('a shared external that requests a served module itself is inlined without walking its closure', () => {
  const root = writeTree({
    'node_modules/@jest/globals/package.json': JSON.stringify({
      name: '@jest/globals',
      main: 'index.js',
    }),
    'node_modules/@jest/globals/index.js':
      "require('./deep.js')\nthrow new Error('not outside Jest')\n",
    'node_modules/@jest/globals/deep.js': 'module.exports = {}\n',
    'node_modules/direct/package.json': JSON.stringify({ name: 'direct', main: 'index.js' }),
    'node_modules/direct/index.js':
      "module.exports = { served: require('@jest/globals').marker }\n",
    'a.test.js': "module.exports = require('direct')\n",
  })
  const inner = createResolver({ root, mappers: [], extensions: ['.js'], tsconfig: false })
  const asked: string[] = []
  const resolver: Resolver = {
    resolve: (specifier, context) => {
      asked.push(specifier)
      return inner.resolve(specifier, context)
    },
    invalidate: (paths) => {
      inner.invalidate(paths)
    },
    fingerprint: inner.fingerprint,
  }
  const loader = loaderFor(
    root,
    { interopDefault: 'babel' },
    { resolver, moduleScope: { names: [], modules: ['@jest/globals'] } },
  )
  const marker = {}
  const loaded = loader
    .createFileRegistry(join(root, 'a.test.js'), {
      tier: 'registry',
      moduleScope: () => ({ '@jest/globals': { marker } }),
    })
    .require<{ served: object }>(join(root, 'a.test.js'))
  assert.equal(loaded.served, marker)
  assert.ok(!asked.includes('./deep.js'), 'the real module’s closure was never scanned')
})

test('a shared external whose closure requires a served module is inlined, and its edge gets the served value', async () => {
  const root = writeTree({
    'node_modules/@jest/globals/package.json': JSON.stringify({
      name: '@jest/globals',
      main: 'index.js',
    }),
    'node_modules/@jest/globals/index.js':
      "throw new Error('Do not import `@jest/globals` outside of the Jest test environment')\n",
    'node_modules/uses-globals/package.json': JSON.stringify({
      name: 'uses-globals',
      main: 'index.js',
    }),
    'node_modules/uses-globals/index.js': "module.exports = require('./lib.js')\n",
    'node_modules/uses-globals/lib.js':
      "const globals = require('@jest/globals')\nmodule.exports = { served: globals.marker }\n",
    'node_modules/plain-ext/package.json': JSON.stringify({ name: 'plain-ext', main: 'index.js' }),
    'node_modules/plain-ext/index.js': 'module.exports = { token: {} }\n',
    'a.test.js':
      "module.exports = { uses: require('uses-globals'), plain: require('plain-ext') }\n",
  })
  const loader = loaderFor(
    root,
    { interopDefault: 'babel' },
    { moduleScope: { names: [], modules: ['@jest/globals'] } },
  )
  const marker = {}
  const load = () =>
    loader
      .createFileRegistry(join(root, 'a.test.js'), {
        tier: 'registry',
        moduleScope: () => ({ '@jest/globals': { marker } }),
      })
      .require<{ uses: { served: object }; plain: { token: object } }>(join(root, 'a.test.js'))
  const first = load()
  assert.equal(first.uses.served, marker, 'the served module, not the real one')
  const second = load()
  assert.equal(second.plain.token, first.plain.token, 'a package that reaches none stays shared')
})

/** A dual package: its `node` branch's `import` and `require` entries name themselves. */
const DUAL = {
  'node_modules/dual/package.json': JSON.stringify({
    name: 'dual',
    exports: { '.': { node: { import: './node.mjs', require: './node.cjs' }, default: './d.cjs' } },
  }),
  'node_modules/dual/node.mjs': "export default 'node-import'\n",
  'node_modules/dual/node.cjs': "module.exports = 'node-require'\n",
  'node_modules/dual/d.cjs': "module.exports = 'default'\n",
  'package.json': '{}\n',
  'helper.ts': "import entry from 'dual'\nexport const fromHelper: string = entry\n",
  'entry.test.ts':
    "import entry from 'dual'\nexport { fromHelper } from './helper.ts'\nexport const fromTest: string = entry\nexport const required: string = require('dual')\n",
}

/**
 * What `entry.test.ts` of the tree at `root` exports, through a registry-tier loader with `policy`
 * (and Babel's `default` interop, which these trees' CommonJS entries are written for).
 */
function importEntry<T = Record<string, string>>(
  root: string,
  policy: Partial<ModulePolicy>,
): Promise<T> {
  const entry = join(root, 'entry.test.ts')
  return loaderFor(root, { ...policy, interopDefault: 'babel' })
    .createFileRegistry(entry, { tier: 'registry' })
    .import<T>(entry)
}

test('edgeResolveKind: importer-format follows the importer, as-written (neutral) the edge', async () => {
  // This process has no `--experimental-vm-modules`, so every module runs as CommonJS (Jest's rule).
  const root = writeTree(DUAL)
  const cases = [
    [
      'importer-format: every edge of a CommonJS-run module resolves as require',
      { edgeResolveKind: 'importer-format' },
      { fromTest: 'node-require', fromHelper: 'node-require', required: 'node-require' },
    ],
    [
      'as-written: an import resolves as import and a require as require',
      {},
      { fromTest: 'node-import', fromHelper: 'node-import', required: 'node-require' },
    ],
  ] as const
  for (const [title, policy, expected] of cases) {
    const entry = await importEntry(root, policy)
    assert.deepEqual(
      { fromTest: entry.fromTest, fromHelper: entry.fromHelper, required: entry.required },
      expected,
      title,
    )
  }
})

test("edgeResolveKind: an import-only package is not found from a CommonJS-run module, with Jest's text", async () => {
  // Jest resolves the edge with its CJS conditions only and fails it; nothing retries it as an
  // `import`, so a virtual mock or a mapper still gets the miss (`review-regressions.test.ts`).
  const root = writeTree({
    'node_modules/esm-only/package.json': JSON.stringify({
      name: 'esm-only',
      exports: { '.': { import: './index.mjs' } },
    }),
    'node_modules/esm-only/index.mjs': "export const value = 'esm-only'\n",
    'package.json': '{}\n',
    'entry.test.ts': "export { value } from 'esm-only'\n",
  })
  const policy = {
    edgeResolveKind: 'importer-format',
    messages: { 'module-not-found': "Cannot find module '{specifier}' from '{from}'" },
  } as const
  await assert.rejects(importEntry(root, policy), {
    code: 'MODULE_NOT_FOUND',
    message: "Cannot find module 'esm-only' from 'entry.test.ts'",
  })
})

/** A dual package that lists `module-sync` first: each entry's value names it. */
const MODULE_SYNC = {
  'node_modules/dual/package.json': JSON.stringify({
    name: 'dual',
    exports: {
      '.': {
        'module-sync': './module-sync.mjs',
        import: './esm.mjs',
        require: './cjs.cjs',
      },
    },
  }),
  'node_modules/dual/module-sync.mjs': "export default 'module-sync'\n",
  'node_modules/dual/esm.mjs': "export default 'import'\n",
  'node_modules/dual/cjs.cjs': "module.exports = 'require'\n",
  'package.json': '{}\n',
  'entry.test.ts':
    "import imported from 'dual'\nexport const fromImport: string = imported\nexport const fromRequire: string = require('dual')\nexport const fromDynamic = async (): Promise<string> => (await import('dual')).default\n",
}

test('moduleSyncCondition: an import edge adds module-sync, a require only where Node evaluates ESM synchronously', async () => {
  // This process has no `--experimental-vm-modules`, so a `require` adds no `module-sync` (the
  // gate's other side is `edge-kind.test.ts`'s, on the capability seam).
  const root = writeTree(MODULE_SYNC)
  const load = (moduleSyncCondition: ModulePolicy['moduleSyncCondition']) =>
    importEntry<{ fromImport: string; fromRequire: string; fromDynamic: () => Promise<string> }>(
      root,
      { moduleSyncCondition },
    )
  const jest = await load('import-and-sync-require')
  assert.deepEqual(
    { import: jest.fromImport, require: jest.fromRequire, dynamic: await jest.fromDynamic() },
    { import: 'module-sync', require: 'require', dynamic: 'module-sync' },
  )
  const neutral = await load('never')
  assert.deepEqual(
    {
      import: neutral.fromImport,
      require: neutral.fromRequire,
      dynamic: await neutral.fromDynamic(),
    },
    { import: 'import', require: 'require', dynamic: 'import' },
  )
})

/** A `package.json` for `name` with an `index.js` entry, and whatever else the test says. */
function pkgJson(name: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ name, main: 'index.js', ...extra })
}

/** The tree entries of an installed package: its manifest and `files`, under `node_modules/<name>`. */
function nodeModule(
  name: string,
  files: Readonly<Record<string, string>>,
  manifest: Readonly<Record<string, unknown>> = {},
): Record<string, string> {
  const entries: Record<string, string> = {
    [`node_modules/${name}/package.json`]: pkgJson(name, manifest),
  }
  for (const [file, text] of Object.entries(files)) entries[`node_modules/${name}/${file}`] = text
  return entries
}

/** Imports `file` from two registries of one loader, the second after the first. */
async function twice<T>(loader: Loader, root: string, file: string): Promise<readonly [T, T]> {
  const first = await importFrom<T>(loader, root, file)
  return [first, await importFrom<T>(loader, root, file)]
}

/**
 * `esm-pkg`: ES module source with no `type` (Node's syntax detection reads it as ESM), whose
 * index imports `./config` with no extension, which Node's own ESM resolver never finds.
 */
const ESM_PACKAGE = nodeModule(
  'esm-pkg',
  {
    'index.js':
      "import { config } from './config'\nexport const token = {}\nexport const name = config.name\n",
    'config.js': "export const config = { name: 'esm' }\n",
  },
  { version: '1.0.0' },
)

/** The default `babel-jest` entry the Oxc path stands in for, with patterns that ignore no package. */
const TAKES_ALL: TransformClaims = {
  patterns: ['\\.[jt]sx?$'],
  ignorePatterns: ['^.+\\.module\\.(css|sass|scss)$'],
}

/** Jest's default `transformIgnorePatterns`: no file under `node_modules` is transformed. */
const JEST_DEFAULT_IGNORE: TransformClaims = {
  patterns: ['\\.[jt]sx?$'],
  ignorePatterns: ['/node_modules/', '\\.pnp\\.[^\\/]+$'],
}

function importFrom<T>(loader: Loader, root: string, file: string): Promise<T> {
  return loader
    .createFileRegistry(join(root, file), { tier: 'registry' })
    .import<T>(join(root, file))
}

test('transformClaims: an ES module package a transform takes is a user module, transformed and evaluated per file', async () => {
  const root = writeTree({
    ...ESM_PACKAGE,
    // `type: module`, and `.mjs`, are ES modules whatever their text says.
    'node_modules/typed/package.json': JSON.stringify({ name: 'typed', type: 'module' }),
    'node_modules/typed/index.js': 'export const token = {}\n',
    'node_modules/typed/other.mjs': 'export const token = {}\n',
    'entry.test.ts':
      "export { name, token } from 'esm-pkg'\nexport { token as typed } from 'typed'\nexport { token as mjs } from 'typed/other.mjs'\n",
  })
  type Loaded = { name: string; token: object; typed: object; mjs: object }
  // `next/jest`'s own transform pattern, which takes `.mjs` (Jest's default `\.[jt]sx?$` does not).
  const nextPattern = { ...TAKES_ALL, patterns: ['^.+\\.(js|jsx|ts|tsx|mjs)$'] }
  // The D127 window is for a native load: a user module opens none, and is evaluated per file anyway.
  const loader = loaderFor(
    root,
    { reevaluateHookingExternals: true },
    { transformClaims: nextPattern },
  )
  const watched: string[] = []
  loader.watchExternalLoads(probe(watched))
  const events: CompiledModuleEvent[] = []
  const stop = loader.onModuleCompiled((event) => events.push(event))
  const [first, second] = await twice<Loaded>(loader, root, 'entry.test.ts')
  stop()
  assert.equal(
    first.name,
    'esm',
    "its extensionless import found, as the transform's output finds it",
  )
  assert.notEqual(first.token, second.token, 'evaluated per file')
  assert.notEqual(first.typed, second.typed, 'a type: module package too')
  assert.notEqual(first.mjs, second.mjs, 'and an .mjs file')
  const packageFiles = events
    .map((event) => event.scriptUrl.slice(root.length))
    .filter((path) => path.startsWith('/node_modules/'))
  assert.deepEqual(packageFiles.toSorted(), [
    '/node_modules/esm-pkg/config.js',
    '/node_modules/esm-pkg/index.js',
    '/node_modules/typed/index.js',
    '/node_modules/typed/other.mjs',
  ])
  assert.ok(
    events.filter((event) => event.scriptUrl.includes('/node_modules/')).every((e) => e.thirdParty),
    'reported to coverage as third party',
  )
  assert.deepEqual(watched, [], 'no native load was watched')
  assert.deepEqual(loader.takeLearnedExternals(), [])
  // A file no pattern matches is no transform's: Jest's default leaves `.mjs` to Node.
  const byDefault = loaderFor(root, {}, { transformClaims: TAKES_ALL })
  const [one, two] = await twice<Loaded>(byDefault, root, 'entry.test.ts')
  assert.notEqual(one.typed, two.typed)
  assert.equal(one.mjs, two.mjs, 'an .mjs file the pattern does not take stays shared')
})

test("transformClaims: Jest's default patterns leave every package to Node: shared, with Node's error or the dialect's require-esm text", async () => {
  const root = writeTree({
    ...ESM_PACKAGE,
    'node_modules/esm-ok/package.json': JSON.stringify({
      name: 'esm-ok',
      type: 'module',
      exports: './index.js',
    }),
    'node_modules/esm-ok/index.js': 'export const token = {}\n',
    'node_modules/cjs-throws/package.json': JSON.stringify({
      name: 'cjs-throws',
      main: 'index.js',
    }),
    'node_modules/cjs-throws/index.js': "throw new Error('cjs-throws failed as it loaded')\n",
    'ok.test.ts': "export { token } from 'esm-ok'\n",
    'entry.test.ts': "export { name } from 'esm-pkg'\n",
    'cjs.test.ts': "export * from 'cjs-throws'\n",
  })
  const shared = loaderFor(root, {}, { transformClaims: JEST_DEFAULT_IGNORE })
  const ok = () => importFrom<{ token: object }>(shared, root, 'ok.test.ts')
  assert.equal((await ok()).token, (await ok()).token, 'shared by the worker')
  // Under `babel` interop an edge requires the external when it runs, as Jest's CommonJS output does.
  const babel = { interopDefault: 'babel' } as const
  await assert.rejects(
    importFrom(
      loaderFor(root, babel, { transformClaims: JEST_DEFAULT_IGNORE }),
      root,
      'entry.test.ts',
    ),
    { code: 'ERR_MODULE_NOT_FOUND' },
    "Node's own error without the dialect's text",
  )
  const jestish = loaderFor(
    root,
    { ...babel, messages: { 'require-esm': 'Must use import to load ES Module: {path}' } },
    { transformClaims: JEST_DEFAULT_IGNORE },
  )
  const index = join(root, 'node_modules/esm-pkg/index.js')
  await assert.rejects(importFrom(jestish, root, 'entry.test.ts'), (error: unknown) => {
    assert.ok(error instanceof RequireEsmError)
    assert.equal(error.name, 'Error')
    assert.equal(error.code, 'ERR_REQUIRE_ESM')
    assert.equal(error.message, `Must use import to load ES Module: ${index}`)
    return true
  })
  await assert.rejects(importFrom(jestish, root, 'cjs.test.ts'), {
    message: 'cjs-throws failed as it loaded',
  })
})

test('transformClaims: a CommonJS package a transform takes stays shared, loaded by Node', async () => {
  const root = writeTree({
    'node_modules/cjs-pkg/package.json': JSON.stringify({
      name: 'cjs-pkg',
      type: 'commonjs',
      main: 'index.js',
    }),
    'node_modules/cjs-pkg/index.js': "exports.token = require('./helper').token\n",
    'node_modules/cjs-pkg/helper.js': 'exports.token = {}\n',
    // No `type`: the source decides, and an `import()` is CommonJS too.
    'node_modules/plain-cjs/package.json': pkgJson('plain-cjs'),
    'node_modules/plain-cjs/index.js':
      "// import and export, in a comment\nmodule.exports = { token: {}, later: () => import('node:os') }\n",
    'entry.test.ts':
      "import cjs from 'cjs-pkg'\nimport plain from 'plain-cjs'\nexport const a = cjs.token\nexport const b = plain.token\n",
  })
  const loader = loaderFor(root, {}, { transformClaims: TAKES_ALL })
  const events: CompiledModuleEvent[] = []
  const stop = loader.onModuleCompiled((event) => events.push(event))
  type Loaded = { a: object; b: object }
  const [first, second] = await twice<Loaded>(loader, root, 'entry.test.ts')
  stop()
  assert.equal(first.a, second.a, 'type: commonjs, shared')
  assert.equal(first.b, second.b, 'CommonJS syntax, shared')
  assert.deepEqual(
    events.filter((event) => event.scriptUrl.includes('/node_modules/')),
    [],
    'no package file was compiled by the loader',
  )
})

test("transformClaims: under pnpm the patterns read the real path, .pnpm/<name>@<v>/node_modules/<name>, as Jest's do", async () => {
  const store = 'node_modules/.pnpm'
  const esm = `${store}/esm-pkg@1.0.0/node_modules/esm-pkg`
  const other = `${store}/other@2.0.0/node_modules/other`
  const root = writeTree({
    ...Object.fromEntries(
      Object.entries(ESM_PACKAGE).map(([path, text]) => [
        path.replace('node_modules/esm-pkg', esm),
        text,
      ]),
    ),
    [`${other}/package.json`]: JSON.stringify({
      name: 'other',
      type: 'module',
      exports: './index.js',
    }),
    [`${other}/index.js`]: 'export const token = {}\n',
    'entry.test.ts':
      "export { name, token } from 'esm-pkg'\nexport { token as other } from 'other'\n",
  })
  symlinkSync(join(root, esm), join(root, 'node_modules/esm-pkg'))
  symlinkSync(join(root, other), join(root, 'node_modules/other'))
  // What `next/jest` (next 16) writes for `transpilePackages: ['esm-pkg']`.
  const nextJest: TransformClaims = {
    patterns: ['\\.[jt]sx?$'],
    ignorePatterns: [
      '/node_modules/(?!.pnpm)(?!(esm-pkg)/)',
      '/node_modules/.pnpm/(?!(esm-pkg)@)',
      '^.+\\.module\\.(css|sass|scss)$',
    ],
  }
  const loader = loaderFor(root, {}, { transformClaims: nextJest })
  type Loaded = { name: string; token: object; other: object }
  const [first, second] = await twice<Loaded>(loader, root, 'entry.test.ts')
  assert.equal(first.name, 'esm')
  assert.notEqual(first.token, second.token, 'the listed package is transformed, per file')
  assert.equal(first.other, second.other, 'another package stays shared')
})

test('transformClaims: a package made a user module meets the file’s mocks and served modules on its own edges', async () => {
  const root = writeTree({
    'node_modules/esm-pkg/package.json': pkgJson('esm-pkg'),
    'node_modules/esm-pkg/index.js':
      "import { who } from './who'\nimport { marker } from '@jest/globals'\nexport { marker, who }\n",
    'node_modules/esm-pkg/who.js': "export { who } from 'dep'\n",
    'node_modules/dep/package.json': pkgJson('dep'),
    'node_modules/dep/index.js': "exports.who = 'real'\n",
    'node_modules/@jest/globals/package.json': JSON.stringify({
      name: '@jest/globals',
      main: 'index.js',
    }),
    'node_modules/@jest/globals/index.js': "throw new Error('not outside Jest')\n",
    'entry.test.ts': "export { marker, who } from 'esm-pkg'\n",
  })
  const dep = join(root, 'node_modules/dep/index.js')
  const fail = (): never => {
    throw new Error('not part of the test')
  }
  const mocks: ModuleMockRegistry = {
    register: fail,
    decide: (id) => (id === dep ? { mocked: true, id } : { mocked: false }),
    decideUnresolved: () => ({ mocked: false }),
    active: () => true,
    generation: () => 0,
    materialize: () => ({ who: 'mock' }),
    mockFor: fail,
    createMockFromModule: fail,
    onResetModules: () => {},
    setAutomock: fail,
    onGenerateMock: fail,
    enterIsolation: fail,
    exitIsolation: fail,
    dispose: () => {},
  }
  const loader = loaderFor(
    root,
    {},
    { moduleScope: { names: [], modules: ['@jest/globals'] }, transformClaims: TAKES_ALL },
  )
  const marker = {}
  const loaded = await loader
    .createFileRegistry(join(root, 'entry.test.ts'), {
      tier: 'registry',
      moduleMocks: () => mocks,
      moduleScope: () => ({ '@jest/globals': { marker } }),
    })
    .import<{ marker: object; who: string }>(join(root, 'entry.test.ts'))
  assert.equal(loaded.who, 'mock', 'the mock reaches the package’s import')
  assert.equal(loaded.marker, marker, 'the served module, not the real one')
})

test('transformClaims: a claimed .ts or .jsx file is a user module whatever its syntax, since Node runs neither from node_modules', async () => {
  const root = writeTree({
    'node_modules/typed-cjs/package.json': pkgJson('typed-cjs', { main: 'index.ts' }),
    'node_modules/typed-cjs/index.ts':
      'const double = (x: number): number => x * 2\nmodule.exports = { double, token: {} }\n',
    'node_modules/jsx-cjs/package.json': pkgJson('jsx-cjs', { main: 'index.jsx' }),
    'node_modules/jsx-cjs/index.jsx':
      '/** @jsxRuntime classic */\n/** @jsx h */\nconst h = (tag) => ({ tag })\nmodule.exports = { el: <b />, token: {} }\n',
    'entry.test.ts':
      "import typed from 'typed-cjs'\nimport jsx from 'jsx-cjs'\nexport const four = typed.double(2)\nexport const tag = jsx.el.tag\nexport const tokens = [typed.token, jsx.token]\n",
  })
  // The Oxc path stands in for the default `babel-jest` entry, whose `\.[jt]sx?$` takes both.
  const loader = loaderFor(root, { interopDefault: 'babel' }, { transformClaims: TAKES_ALL })
  type Loaded = { four: number; tag: string; tokens: readonly [object, object] }
  const [first, second] = await twice<Loaded>(loader, root, 'entry.test.ts')
  assert.equal(first.four, 4, 'the TypeScript file, transformed')
  assert.equal(first.tag, 'b', 'the JSX file, transformed')
  assert.notEqual(first.tokens[0], second.tokens[0], 'evaluated per file')
  assert.notEqual(first.tokens[1], second.tokens[1], 'evaluated per file')
})

test('transformClaims: a claimed CommonJS file whose load threw a SyntaxError it did parse is not run again on another route', async () => {
  const runs = (): number => Reflect.get(globalThis, '__claimRuns') as number
  const bump = 'globalThis.__claimRuns = (globalThis.__claimRuns ?? 0) + 1\n'
  const root = writeTree({
    'node_modules/throws/package.json': pkgJson('throws', { main: 'json.js' }),
    'node_modules/throws/json.js': `${bump}JSON.parse('{')\n`,
    'node_modules/throws/function.js': `${bump}new Function('<')\n`,
    // Its own code parses; what it requires does not, and the error is that file's.
    'node_modules/throws/parent.js': `${bump}module.exports = require('./jsx')\n`,
    'node_modules/throws/jsx.js': 'module.exports = <b />\n',
    'json.test.ts': "import 'throws'\n",
    'function.test.ts': "import 'throws/function.js'\n",
    'parent.test.ts': "import 'throws/parent.js'\n",
  })
  // Under `babel` interop the edge requires the package when it runs, as Jest's CommonJS output does.
  const loader = loaderFor(root, { interopDefault: 'babel' }, { transformClaims: TAKES_ALL })
  for (const [file, message] of [
    ['json.test.ts', /JSON/],
    ['function.test.ts', /Unexpected token '<'/],
    ['parent.test.ts', /Unexpected token '<'/],
  ] as const) {
    Reflect.set(globalThis, '__claimRuns', 0)
    await assert.rejects(importFrom(loader, root, file), (error: unknown) => {
      assert.ok(error instanceof SyntaxError, file)
      assert.match(error.message, message)
      return true
    })
    assert.equal(runs(), 1, `${file}: its module ran once`)
  }
})

/** CommonJS packages that require a claimed ES module, as mixpanel's CommonJS build requires its ES module helpers. */
const REQUIRES_CLAIMED = {
  ...ESM_PACKAGE,
  'node_modules/esm-plain/package.json': pkgJson('esm-plain'),
  'node_modules/esm-plain/index.js': 'export const token = {}\n',
  'node_modules/cjs-pkg-user/package.json': JSON.stringify({
    name: 'cjs-pkg-user',
    main: 'index.js',
  }),
  'node_modules/cjs-pkg-user/index.js': "module.exports = require('esm-pkg')\n",
  'node_modules/cjs-plain-user/package.json': JSON.stringify({
    name: 'cjs-plain-user',
    main: 'index.js',
  }),
  'node_modules/cjs-plain-user/index.js': "module.exports = require('esm-plain')\n",
  // Named imports: `module.exports = require(esm)` carries `__esModule`, so a default import is
  // `undefined` under `babel` interop, as in Jest.
  'crash.test.ts': "export { name } from 'cjs-pkg-user'\n",
  'instance.test.ts':
    "import { token as viaCjs } from 'cjs-plain-user'\nimport { token } from 'esm-plain'\nexport const same = viaCjs === token\n",
}

test('transformClaims: a shared CommonJS package that requires a claimed ES module is inlined: no crash, and one instance', async () => {
  const root = writeTree(REQUIRES_CLAIMED)
  // `next/jest`'s shape: the ES modules are let through, the CommonJS packages that require them are
  // not; then patterns that ignore no package, where the CommonJS ones are claimed and loaded by Node.
  const allowlist: TransformClaims = {
    patterns: ['\\.[jt]sx?$'],
    ignorePatterns: ['/node_modules/(?!(esm-pkg|esm-plain)/)'],
  }
  for (const claims of [allowlist, TAKES_ALL]) {
    const loader = loaderFor(root, { interopDefault: 'babel' }, { transformClaims: claims })
    const crash = await importFrom<{ name: string }>(loader, root, 'crash.test.ts')
    assert.equal(
      crash.name,
      'esm',
      "its require of esm-pkg is the transformed one, './config' found",
    )
    const instance = await importFrom<{ same: boolean }>(loader, root, 'instance.test.ts')
    assert.equal(instance.same, true, "the package's copy is the file's own, not Node's")
  }
})

/** A watcher like the worker's under `reevaluatePatchingExternals`: a key the load added is a write. */
function writeProbe(watched: string[]): (path: string) => (() => boolean) | null {
  return (path) => {
    watched.push(path)
    const before = new Set(Object.getOwnPropertyNames(globalThis))
    return () => Object.getOwnPropertyNames(globalThis).some((key) => !before.has(key))
  }
}

test('reevaluatePatchingExternals: an ES module package that adds a global as it loads is evaluated per file from the next file, with what only it imports', async () => {
  const root = writeTree({
    // ES modules only, loaded by a CommonJS file through Node's require(esm).
    'node_modules/writes-esm/package.json': JSON.stringify({
      name: 'writes-esm',
      type: 'module',
      exports: './index.js',
    }),
    'node_modules/writes-esm/index.js':
      "import { tag } from 'writes-dep'\nimport shared from 'shared-dep'\nglobalThis.__provinoWritesEsm = (globalThis.__provinoWritesEsm ?? 0) + 1\nexport const token = {}\nexport const depToken = tag\nexport const sharedToken = shared.token\n",
    // Imported by writes-esm alone: it joins the per-file set (D132).
    'node_modules/writes-dep/package.json': JSON.stringify({
      name: 'writes-dep',
      type: 'module',
      exports: './index.js',
    }),
    'node_modules/writes-dep/index.js': 'export const tag = {}\n',
    // Imported by writes-esm and by a package that writes nothing: it stays shared.
    'node_modules/shared-dep/package.json': JSON.stringify({
      name: 'shared-dep',
      main: 'index.js',
    }),
    'node_modules/shared-dep/index.js': 'module.exports = { token: {} }\n',
    'node_modules/plain-cjs/package.json': JSON.stringify({ name: 'plain-cjs', main: 'index.js' }),
    'node_modules/plain-cjs/index.js': "module.exports = { shared: require('shared-dep') }\n",
    'a.test.js':
      "module.exports = { plain: require('plain-cjs'), writes: require('writes-esm') }\n",
    'b.test.js':
      "module.exports = { plain: require('plain-cjs'), writes: require('writes-esm') }\n",
  })
  interface Written {
    readonly plain: { readonly shared: { readonly token: object } }
    readonly writes: {
      readonly token: object
      readonly depToken: object
      readonly sharedToken: object
    }
  }
  const loader = loaderFor(root, { reevaluatePatchingExternals: true, interopDefault: 'babel' })
  const watched: string[] = []
  loader.watchExternalLoads(writeProbe(watched))
  const load = (name: string) =>
    loader
      .createFileRegistry(join(root, name), { tier: 'registry' })
      .import<Written>(join(root, name))
  const flag = (): unknown => Reflect.get(globalThis, '__provinoWritesEsm')
  try {
    const first = await load('a.test.js')
    assert.deepEqual(
      watched.map((path) => path.slice(root.length + 1)),
      ['node_modules/plain-cjs/index.js', 'node_modules/writes-esm/index.js'],
      'one window per external; what a load imports is part of its window',
    )
    assert.equal(flag(), 1)
    const learned = loader.takeLearnedExternals().map((path) => path.slice(root.length + 1))
    assert.ok(
      learned.includes('node_modules/writes-esm/index.js'),
      'the writing package is learned',
    )
    assert.ok(
      !learned.some((path) => path.startsWith('node_modules/plain-cjs/')),
      'a package that writes nothing is not',
    )
    assert.deepEqual(loader.takeLearnedExternals(), [], 'each is handed out once')
    const second = await load('b.test.js')
    assert.equal(flag(), 2, 'the second file evaluates the package again')
    assert.notEqual(second.writes.token, first.writes.token, 'writes-esm is the second file’s own')
    assert.notEqual(second.writes.depToken, first.writes.depToken, 'so is what only it imports')
    assert.equal(
      second.writes.sharedToken,
      first.writes.sharedToken,
      'a dependency a shared package imports too stays shared',
    )
    assert.equal(second.writes.sharedToken, second.plain.shared.token)
    assert.deepEqual(
      watched.slice(2).map((path) => path.slice(root.length + 1)),
      ['node_modules/shared-dep/index.js'],
      'only the shared dependency’s first load from a user module (the per-file copy) is a window',
    )
  } finally {
    Reflect.deleteProperty(globalThis, '__provinoWritesEsm')
  }
})

test('reevaluateHookingExternals: a package whose closure Node would resolve to another build under the environment’s conditions goes through the registry from the first file', () => {
  // `split` maps a `browser` build, the DOM environment's; Node's own `require` finds the other.
  const source =
    "module.exports = { lib: require('lib'), split: require('split'), plain: require('plain') }\n"
  const root = writeTree({
    'node_modules/split/package.json': JSON.stringify({
      name: 'split',
      exports: { '.': { browser: './browser.js', default: './node.js' } },
    }),
    'node_modules/split/browser.js': "module.exports = { build: 'browser' }\n",
    'node_modules/split/node.js': "module.exports = { build: 'node' }\n",
    ...pkg('lib', "module.exports = { split: require('split') }\n"),
    ...pkg('plain', 'module.exports = {}\n'),
    'a.test.js': source,
    'b.test.js': source,
  })
  type Loaded = { lib: { split: { build: string } }; split: { build: string }; plain: object }
  const loaderUnder = (conditions: readonly string[]): Loader =>
    createLoader({
      ...loaderOptionsFor(root, {
        policy: { reevaluateHookingExternals: true, interopDefault: 'babel' },
      }),
      conditions,
    })
  const load = (loader: Loader, name: string): Loaded =>
    loader
      .createFileRegistry(join(root, name), { tier: 'registry' })
      .require<Loaded>(join(root, name))
  const dom = loaderUnder(['browser'])
  const first = load(dom, 'a.test.js')
  assert.equal(first.lib.split.build, 'browser', 'the first file gets the environment’s build')
  assert.equal(first.lib.split, first.split, 'and one copy of it')
  const second = load(dom, 'b.test.js')
  assert.equal(second.lib.split.build, 'browser')
  assert.notEqual(second.lib, first.lib, 'the package is evaluated per file')
  assert.equal(second.plain, first.plain, 'one Node resolves the same way stays shared')
  // Under Node's own conditions nothing changes: the package loads natively, once per worker.
  const node = loaderUnder(['node'])
  const nodeFirst = load(node, 'a.test.js')
  assert.equal(nodeFirst.lib.split.build, 'node')
  assert.equal(load(node, 'b.test.js').lib, nodeFirst.lib)
})

test('with both reevaluate keys off, no external load is watched', async () => {
  const root = writeTree({
    'node_modules/writes-cjs/package.json': JSON.stringify({
      name: 'writes-cjs',
      main: 'index.js',
    }),
    'node_modules/writes-cjs/index.js':
      'globalThis.__provinoWritesCjs = true\nmodule.exports = {}\n',
    'a.test.js': "module.exports = require('writes-cjs')\n",
  })
  const loader = loaderFor(root, {
    reevaluatePatchingExternals: false,
    reevaluateHookingExternals: false,
  })
  const watched: string[] = []
  loader.watchExternalLoads(writeProbe(watched))
  try {
    await loader
      .createFileRegistry(join(root, 'a.test.js'), { tier: 'registry' })
      .import(join(root, 'a.test.js'))
    assert.deepEqual(watched, [])
    assert.deepEqual(loader.takeLearnedExternals(), [])
  } finally {
    Reflect.deleteProperty(globalThis, '__provinoWritesCjs')
  }
})
