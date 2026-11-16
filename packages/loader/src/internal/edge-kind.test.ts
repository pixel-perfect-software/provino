// `ModulePolicy.edgeResolveKind`: which kind an edge resolves as, by the importer's format, and
// `ModulePolicy.moduleSyncCondition`: which lookups add `module-sync`. Recorded from Jest 30.5.2 by
// `env/conditions-import-*` (`-module-sync` is the condition's; `provino`'s
// `jest-conditions.test.ts`). The `require` half of `moduleSyncCondition` depends on whether Node
// evaluates an ES module graph synchronously, which differs between the Node versions CI runs, so
// it is held here on the capability seam rather than by a recording.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ModulePolicy } from '@provino/types'
import {
  createEdgeKindState,
  type EdgeKindOptions,
  edgeConditions,
  edgeKind,
  type RuntimeCapabilities,
  runsAsEsm,
} from './edge-kind.ts'
import { writeTree } from './test-support.ts'

/** Node with `--experimental-vm-modules` and sync evaluation (24.9 and later). */
const VM_MODULES: RuntimeCapabilities = { vmModules: true, syncEvaluate: true }
/** Node with `--experimental-vm-modules` and no sync evaluation (22, and 24 before 24.9). */
const NO_SYNC_EVALUATE: RuntimeCapabilities = { vmModules: true, syncEvaluate: false }
/** Node without the flag: neither. */
const NO_VM_MODULES: RuntimeCapabilities = { vmModules: false, syncEvaluate: false }

function options(
  edgeResolveKind: ModulePolicy['edgeResolveKind'],
  esmExtensions?: readonly string[],
  moduleSyncCondition: ModulePolicy['moduleSyncCondition'] = 'never',
  conditions?: readonly string[],
): EdgeKindOptions {
  return {
    policy: { edgeResolveKind, moduleSyncCondition },
    ...(esmExtensions === undefined ? {} : { esmExtensions }),
    ...(conditions === undefined ? {} : { conditions }),
  }
}

test('as-written: every edge keeps its own kind', () => {
  const state = createEdgeKindState(options('as-written'), VM_MODULES)
  for (const kind of ['import', 'require', 'dynamic-import', 'import-meta-resolve'] as const) {
    assert.equal(edgeKind(state, '/p/a.ts', kind), kind)
    assert.equal(edgeKind(state, '/p/a.mjs', kind), kind)
  }
})

test('importer-format: a CommonJS-run module resolves every edge as require', () => {
  const root = writeTree({ 'package.json': '{}\n', 'a.ts': '', 'b.js': '', 'c.cjs': '' })
  const state = createEdgeKindState(options('importer-format'), VM_MODULES)
  for (const file of ['a.ts', 'b.js', 'c.cjs']) {
    for (const kind of ['import', 'require', 'dynamic-import'] as const) {
      assert.equal(edgeKind(state, join(root, file), kind), 'require', `${file} ${kind}`)
    }
  }
})

test('importer-format: an ES-module-run module resolves every edge as import', () => {
  const root = writeTree({
    'esm/package.json': '{"type":"module"}\n',
    'esm/deep/b.js': '',
    'esm/c.cjs': '',
    'a.mjs': '',
    'd.ts': '',
    'package.json': '{"type":"commonjs"}\n',
  })
  const state = createEdgeKindState(options('importer-format', ['.ts']), VM_MODULES)
  for (const file of ['esm/deep/b.js', 'a.mjs', 'd.ts']) {
    assert.equal(runsAsEsm(state, join(root, file)), true, file)
    assert.equal(edgeKind(state, join(root, file), 'require'), 'import', file)
  }
  // `.cjs` is CommonJS whatever its package says.
  assert.equal(edgeKind(state, join(root, 'esm/c.cjs'), 'import'), 'require')
})

test('importer-format: the nearest package.json decides a .js file, and a broken one is CommonJS', () => {
  const root = writeTree({
    'package.json': '{"type":"module"}\n',
    'inner/package.json': '{"name":"inner"}\n',
    'inner/a.js': '',
    'broken/package.json': '{ not json',
    'broken/b.js': '',
    'c.js': '',
  })
  const state = createEdgeKindState(options('importer-format'), VM_MODULES)
  assert.equal(runsAsEsm(state, join(root, 'inner/a.js')), false)
  assert.equal(runsAsEsm(state, join(root, 'broken/b.js')), false)
  assert.equal(runsAsEsm(state, join(root, 'c.js')), true)
})

test('importer-format: one manifest answers every .js file under it, read once', () => {
  const root = writeTree({
    'package.json': '{"type":"module"}\n',
    'a.js': '',
    'x/b.js': '',
    'x/y/c.js': '',
  })
  const state = createEdgeKindState(options('importer-format'), VM_MODULES)
  for (const file of ['a.js', 'x/b.js', 'x/y/c.js']) {
    assert.equal(runsAsEsm(state, join(root, file)), true, file)
  }
  assert.deepEqual([...state.moduleTypeByManifest], [[join(root, 'package.json'), true]])
})

test('importer-format without vm modules: every module is CommonJS, as Jest has it', () => {
  const root = writeTree({
    'package.json': '{"type":"module"}\n',
    'a.js': '',
    'b.mjs': '',
    'c.ts': '',
  })
  const state = createEdgeKindState(options('importer-format', ['.ts']), NO_VM_MODULES)
  for (const file of ['a.js', 'b.mjs', 'c.ts']) {
    assert.equal(edgeKind(state, join(root, file), 'import'), 'require', file)
  }
})

test('import.meta.resolve keeps its own kind under importer-format', () => {
  const state = createEdgeKindState(options('importer-format'), VM_MODULES)
  assert.equal(edgeKind(state, '/p/a.ts', 'import-meta-resolve'), 'import-meta-resolve')
})

const KINDS = ['import', 'dynamic-import', 'import-meta-resolve', 'require'] as const

/** The conditions of each kind's lookup, by kind. */
function conditionsByKind(
  moduleSyncCondition: ModulePolicy['moduleSyncCondition'],
  runtime: RuntimeCapabilities,
): Record<string, readonly string[]> {
  const state = createEdgeKindState(
    options('importer-format', undefined, moduleSyncCondition, ['node', 'node-addons']),
    runtime,
  )
  return Object.fromEntries(KINDS.map((kind) => [kind, edgeConditions(state, kind)]))
}

test('moduleSyncCondition never: no lookup adds module-sync, whatever Node can do', () => {
  for (const runtime of [VM_MODULES, NO_SYNC_EVALUATE, NO_VM_MODULES]) {
    for (const conditions of Object.values(conditionsByKind('never', runtime))) {
      assert.deepEqual(conditions, ['node', 'node-addons'])
    }
  }
})

test('moduleSyncCondition import-and-sync-require: an import adds module-sync, a require only with sync evaluation', () => {
  // jest-runtime's `Resolution.ts` L35-48: ESM `module-sync` always, CJS when `supportsSyncEvaluate`.
  const withModuleSync = ['node', 'node-addons', 'module-sync']
  assert.deepEqual(conditionsByKind('import-and-sync-require', VM_MODULES), {
    import: withModuleSync,
    'dynamic-import': withModuleSync,
    'import-meta-resolve': withModuleSync,
    require: withModuleSync,
  })
  for (const runtime of [NO_SYNC_EVALUATE, NO_VM_MODULES]) {
    assert.deepEqual(conditionsByKind('import-and-sync-require', runtime), {
      import: withModuleSync,
      'dynamic-import': withModuleSync,
      'import-meta-resolve': withModuleSync,
      require: ['node', 'node-addons'],
    })
  }
})

test('moduleSyncCondition: module-sync is not added twice, and the default conditions are node', () => {
  const given = createEdgeKindState(
    options('importer-format', undefined, 'import-and-sync-require', ['module-sync', 'node']),
    VM_MODULES,
  )
  assert.deepEqual(edgeConditions(given, 'import'), ['module-sync', 'node'])
  const defaults = createEdgeKindState(
    options('as-written', undefined, 'import-and-sync-require'),
    NO_SYNC_EVALUATE,
  )
  assert.deepEqual(edgeConditions(defaults, 'import'), ['node', 'module-sync'])
  assert.deepEqual(edgeConditions(defaults, 'require'), ['node'])
})

test("this process's capabilities are read as jest-runtime reads them", async () => {
  // The default state's answers come from `node:vm`, the seam the tests above replace. In a child
  // with `--experimental-vm-modules` both members exist; `hasAsyncGraph` only from Node 24.9.
  const { spawnSync } = await import('node:child_process')
  const probe = (flags: readonly string[], env: NodeJS.ProcessEnv) => {
    const result = spawnSync(
      process.execPath,
      [
        ...flags,
        '--no-warnings',
        '--input-type=module',
        '-e',
        "import * as vm from 'node:vm'; console.log(JSON.stringify({ vmModules: typeof vm.SyntheticModule === 'function', syncEvaluate: typeof vm.SourceTextModule?.prototype.hasAsyncGraph === 'function' }))",
      ],
      { encoding: 'utf8', env },
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as RuntimeCapabilities
  }
  const bare = { ...process.env, NODE_OPTIONS: '' }
  const flagged = probe(['--experimental-vm-modules'], bare)
  assert.equal(flagged.vmModules, true)
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major > 24 || (major === 24 && minor >= 9)) assert.equal(flagged.syncEvaluate, true)
  assert.deepEqual(probe([], bare), { vmModules: false, syncEvaluate: false })
  // The default state reads this process's own answers: a child with its flags gives the same.
  const own = createEdgeKindState(options('importer-format', undefined, 'import-and-sync-require'))
  assert.deepEqual(own.runtime(), probe(process.execArgv, process.env))
  assert.equal(own.runtime(), own.runtime(), 'probed once')
})
