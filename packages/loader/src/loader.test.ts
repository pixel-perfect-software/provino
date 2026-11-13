import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type {
  CompiledModuleEvent,
  HoistPolicy,
  Loader,
  ModulePolicy,
  Resolver,
} from '@provino/types'
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
  extra: {
    readonly resolver?: Resolver
    readonly hoist?: HoistPolicy
    readonly moduleScope?: { readonly names: readonly string[] }
  } = {},
): Loader {
  return createLoader({
    root,
    engine: 'runner',
    resolver:
      extra.resolver ??
      createResolver({
        root,
        mappers: [],
        extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
        tsconfig: false,
      }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: extra.hoist ?? null,
      cache: false,
    }),
    policy: { ...neutralPolicy.module, ...policy },
    ...(extra.moduleScope === undefined ? {} : { moduleScope: extra.moduleScope }),
  })
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

/** A Jest-shaped hoist policy for this test only (the dialect's value is not used here). */
const HOIST: HoistPolicy = {
  id: 'loader-test',
  objects: [{ kind: 'global', name: 'mocker' }],
  hoistCalls: { mock: 'path-factory-options', unmock: 'one-string' },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: true,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  messages: {
    HOIST_FACTORY_OUT_OF_SCOPE: 'out of scope',
    HOIST_FACTORY_NOT_FUNCTION: 'not a function',
    HOIST_NOT_TOP_LEVEL: 'not top level',
    HOIST_NESTED: 'nested',
    HOIST_EXPORTED: 'exported',
    HOIST_EXPORTED_VALUE: 'exported value',
  },
}

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
