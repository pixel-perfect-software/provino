// `ResolveProjectOptions.native` (B27a, D186): the native runtime's refs stand in for a dialect's
// matcher table, served modules and globals when no dialect is selected, and are ignored when one
// is. Fake dialects and refs only (this package names none).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  defineDialect,
  moduleRef,
  nativeHoistPolicy,
  nativeSnapshotPolicy,
  neutralPolicy,
  resolvePolicy,
} from '@provino/policy'
import type {
  InlineSnapshotWriterFactory,
  NativeRuntimeRefs,
  SnapshotPrinterFactory,
} from '@provino/types'
import { afterAll, beforeAll, describe, test } from 'provino'
import { makeTempDir, neutralProject, rejectsWith, type TempDir } from './internal/test-support.ts'
import { resolveNeutralProject, resolveProject } from './resolve.ts'

const ENVIRONMENTS = { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } }

const PRINTER = moduleRef<SnapshotPrinterFactory>(
  'file:///native/printer.mjs',
  'nativeSnapshotPrinter',
)

const NATIVE: NativeRuntimeRefs = {
  matcherTable: moduleRef('file:///native/table.mjs', 'provinoExpectTable'),
  moduleScope: moduleRef('file:///native/api.mjs', 'provinoModuleScope'),
  modules: ['provino'],
  globals: moduleRef('file:///native/api.mjs', 'provinoGlobals'),
  hoist: nativeHoistPolicy('provino'),
  snapshotPrinter: PRINTER,
}

const scoped = defineDialect({
  name: 'scoped',
  version: '1',
  policy: { core: { injectGlobals: true } },
  globals: { factory: moduleRef('file:///scoped/globals.mjs', 'globals'), names: ['describe'] },
  moduleScope: {
    names: ['scoped'],
    modules: ['@scoped/globals'],
    factory: moduleRef('file:///scoped/scope.mjs', 'scope'),
  },
})

let temp: TempDir
let configPath: string
beforeAll(async () => {
  temp = await makeTempDir()
  configPath = join(temp.dir, 'provino.config.mjs')
})
afterAll(() => temp.dispose())

/** The resolve options, with `native` (`null`: none). */
function options(native: NativeRuntimeRefs | null = NATIVE) {
  return {
    configPath,
    dialects: [scoped],
    environments: ENVIRONMENTS,
    ci: false,
    ...(native === null ? {} : { native }),
  }
}

describe('a project with no dialect', () => {
  test('the refs land in the policy, the module scope and the served modules', async () => {
    const resolved = await resolveProject({}, options())
    assert.equal(resolved.dialect, null)
    assert.deepEqual(resolved.policy.expect.matcherTable, NATIVE.matcherTable)
    assert.deepEqual(resolved.config.policy.expect.matcherTable, NATIVE.matcherTable)
    assert.deepEqual(resolved.config.moduleScope, NATIVE.moduleScope)
    assert.deepEqual(resolved.config.loader.scopeModules, ['provino'])
    // The served module carries no per-module names: nothing is declared in a module's wrapper.
    assert.deepEqual(resolved.config.loader.moduleScope, [])
    // Globals are off by default (`injectGlobals: false`), so the globals ref is not used.
    assert.equal(resolved.policy.core.injectGlobals, false)
    assert.equal(resolved.config.globals, null)
    // The native API's `mock` hoists (B27j).
    assert.deepEqual(resolved.config.loader.hoist, NATIVE.hoist)
  })

  test('the snapshot printer brings the native snapshot slice (B28)', async () => {
    const resolved = await resolveProject({}, options())
    assert.deepEqual(
      resolved.policy.snapshot,
      resolvePolicy({ snapshot: nativeSnapshotPolicy({ snapshotPrinter: PRINTER }) }).snapshot,
    )
    assert.deepEqual(resolved.config.policy.snapshot.printer, PRINTER)
    assert.equal(resolved.config.policy.snapshot.inline.writer, null)
  })

  test('a snapshot writer is the inline writer; without a printer the slice stays neutral', async () => {
    const snapshotWriter = moduleRef<InlineSnapshotWriterFactory>(
      'file:///native/writer.mjs',
      'nativeInlineSnapshotWriter',
    )
    const written = await resolveProject({}, options({ ...NATIVE, snapshotWriter }))
    assert.deepEqual(written.config.policy.snapshot.inline.writer, snapshotWriter)
    const { snapshotPrinter: _printer, ...withoutPrinter } = NATIVE
    const bare = await resolveProject({}, options({ ...withoutPrinter, snapshotWriter }))
    assert.deepEqual(bare.policy.snapshot, neutralPolicy.snapshot)
  })

  test("a project's own policy layers over the native snapshot slice", async () => {
    const resolved = await resolveNeutralProject(
      { ...neutralProject(temp.dir), policy: { snapshot: { keyJoin: ' > ' } } },
      { dialect: null, environments: ENVIRONMENTS, ci: false, native: NATIVE },
    )
    assert.equal(resolved.policy.snapshot.keyJoin, ' > ')
    assert.deepEqual(resolved.policy.snapshot.printer, PRINTER)
  })

  test('globals: true injects the native globals', async () => {
    const resolved = await resolveProject({ globals: true }, options())
    assert.equal(resolved.policy.core.injectGlobals, true)
    assert.deepEqual(resolved.config.globals, NATIVE.globals)
    assert.deepEqual(resolved.config.moduleScope, NATIVE.moduleScope)
  })

  test('without the refs it keeps the neutral null table and serves nothing', async () => {
    const resolved = await resolveProject({}, options(null))
    assert.equal(resolved.policy.expect.matcherTable, null)
    assert.equal(resolved.config.moduleScope, null)
    assert.equal(resolved.config.loader.scopeModules, undefined)
    assert.equal(resolved.config.loader.hoist, null)
  })

  test('a neutral project a reader produced with no dialect gets them too', async () => {
    const resolved = await resolveNeutralProject(neutralProject(temp.dir), {
      dialect: null,
      environments: ENVIRONMENTS,
      ci: false,
      native: NATIVE,
    })
    assert.deepEqual(resolved.config.policy.expect.matcherTable, NATIVE.matcherTable)
    assert.deepEqual(resolved.config.moduleScope, NATIVE.moduleScope)
    assert.deepEqual(resolved.config.loader.scopeModules, ['provino'])
  })
})

describe('a project with a dialect ignores them', () => {
  test('a dialect named in the config keeps its own table, scope and globals', async () => {
    const resolved = await resolveProject({ dialect: 'scoped' as never }, options())
    assert.equal(resolved.dialect, scoped)
    assert.equal(resolved.policy.expect.matcherTable, null)
    assert.deepEqual(resolved.policy.snapshot, neutralPolicy.snapshot)
    assert.deepEqual(resolved.config.moduleScope, scoped.moduleScope?.factory)
    assert.deepEqual(resolved.config.loader.scopeModules, ['@scoped/globals'])
    assert.deepEqual(resolved.config.globals, scoped.globals?.factory)
    // A dialect with no hoist policy of its own gets none: the native one is the native API's.
    assert.equal(resolved.config.loader.hoist, null)
  })

  test("a reader's project with a dialect", async () => {
    const resolved = await resolveNeutralProject(neutralProject(temp.dir), {
      dialect: scoped,
      environments: ENVIRONMENTS,
      ci: false,
      native: NATIVE,
    })
    assert.equal(resolved.policy.expect.matcherTable, null)
    assert.deepEqual(resolved.config.moduleScope, scoped.moduleScope?.factory)
  })

  test("and doesn't check them", async () => {
    const bad: NativeRuntimeRefs = {
      ...NATIVE,
      matcherTable: { ...NATIVE.matcherTable, module: './table.mjs' },
    }
    const resolved = await resolveProject({ dialect: 'scoped' as never }, options(bad))
    assert.equal(resolved.dialect, scoped)
  })
})

describe('bad refs are config errors', () => {
  test('native refs with no hoist policy hoist nothing', async () => {
    const { hoist: _hoist, ...withoutHoist } = NATIVE
    const resolved = await resolveProject({}, options(withoutHoist))
    assert.equal(resolved.config.loader.hoist, null)
  })

  test('a hoist that is not a policy is CONFIG_INVALID naming native.hoist', async () => {
    const error = await rejectsWith(
      resolveProject({}, options({ ...NATIVE, hoist: 'mock' as never })),
      'CONFIG_INVALID',
    )
    assert.match(error.message, /^native\.hoist must be a hoist policy/)
  })

  for (const key of [
    'matcherTable',
    'moduleScope',
    'globals',
    'snapshotPrinter',
    'snapshotWriter',
  ] as const) {
    test(`a relative ${key} ref is CONFIG_INVALID naming native.${key}`, async () => {
      const bad: NativeRuntimeRefs = {
        ...NATIVE,
        [key]: { module: './native.mjs', export: 'x' },
      }
      const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
      assert.match(error.message, new RegExp(`^native\\.${key}\\.module must be an absolute path`))
    })
  }

  test('a package specifier is refused as well, even for globals a project leaves off', async () => {
    const bad: NativeRuntimeRefs = {
      ...NATIVE,
      globals: { ...NATIVE.globals, module: '@provino/api' },
    }
    const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
    assert.match(error.message, /^native\.globals\.module/)
  })

  test('a closure in place of a ref is CONFIG_INVALID', async () => {
    const bad = {
      ...NATIVE,
      moduleScope: (() => () => ({})) as unknown as NativeRuntimeRefs['moduleScope'],
    }
    const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
    assert.match(error.message, /^native\.moduleScope must be a \{ module, export \} ref/)
  })

  test('an empty specifier in modules is CONFIG_INVALID', async () => {
    const bad: NativeRuntimeRefs = { ...NATIVE, modules: ['provino', ''] }
    const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
    assert.match(error.message, /^native\.modules/)
  })

  test('refs that are not an object are CONFIG_INVALID, not a TypeError', async () => {
    for (const native of [null, 'refs', 1]) {
      const error = await rejectsWith(
        resolveProject({}, { ...options(null), native: native as unknown as NativeRuntimeRefs }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /^native must be an object/)
    }
  })

  test('modules must be an array of specifiers', async () => {
    const bad = { ...NATIVE, modules: 'provino' as unknown as readonly string[] }
    const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
    assert.match(error.message, /^native\.modules must be an array/)
  })
})
