// `ResolveProjectOptions.native` (B27a, D186): the native runtime's refs stand in for a dialect's
// matcher table, served modules and globals when no dialect is selected, and are ignored when one
// is. Fake dialects and refs only (this package names none).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { defineDialect, moduleRef } from '@provino/policy'
import type { NativeRuntimeRefs, NeutralProject } from '@provino/types'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { resolveNeutralProject, resolveProject } from './resolve.ts'

const ENVIRONMENTS = { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } }

const NATIVE: NativeRuntimeRefs = {
  matcherTable: moduleRef('file:///native/table.mjs', 'provinoExpectTable'),
  moduleScope: moduleRef('file:///native/api.mjs', 'provinoModuleScope'),
  modules: ['provino'],
  globals: moduleRef('file:///native/api.mjs', 'provinoGlobals'),
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
before(async () => {
  temp = await makeTempDir()
  configPath = join(temp.dir, 'provino.config.mjs')
})
after(() => temp.dispose())

function options(native: NativeRuntimeRefs | undefined = NATIVE) {
  return {
    configPath,
    dialects: [scoped],
    environments: ENVIRONMENTS,
    ci: false,
    ...(native === undefined ? {} : { native }),
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
  })

  test('globals: true injects the native globals', async () => {
    const resolved = await resolveProject({ globals: true }, options())
    assert.equal(resolved.policy.core.injectGlobals, true)
    assert.deepEqual(resolved.config.globals, NATIVE.globals)
    assert.deepEqual(resolved.config.moduleScope, NATIVE.moduleScope)
  })

  test('without the refs it keeps the neutral null table and serves nothing', async () => {
    const resolved = await resolveProject({}, { ...options(), native: undefined })
    assert.equal(resolved.policy.expect.matcherTable, null)
    assert.equal(resolved.config.moduleScope, null)
    assert.equal(resolved.config.loader.scopeModules, undefined)
  })

  test('a neutral project a reader produced with no dialect gets them too', async () => {
    const resolved = await resolveNeutralProject(neutral(), {
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
    const resolved = await resolveProject({ dialect: 'scoped' }, options())
    assert.equal(resolved.dialect?.name, 'scoped')
    assert.equal(resolved.policy.expect.matcherTable, null)
    assert.deepEqual(resolved.config.moduleScope, scoped.moduleScope?.factory)
    assert.deepEqual(resolved.config.loader.scopeModules, ['@scoped/globals'])
    assert.deepEqual(resolved.config.globals, scoped.globals?.factory)
  })

  test("a reader's project with a dialect", async () => {
    const resolved = await resolveNeutralProject(neutral(), {
      dialect: scoped,
      environments: ENVIRONMENTS,
      ci: false,
      native: NATIVE,
    })
    assert.equal(resolved.policy.expect.matcherTable, null)
    assert.deepEqual(resolved.config.moduleScope, scoped.moduleScope?.factory)
  })

  test("and doesn't check them", async () => {
    const bad = { ...NATIVE, matcherTable: moduleRef('./table.mjs', 'table') }
    const resolved = await resolveProject({ dialect: 'scoped' }, options(bad))
    assert.equal(resolved.dialect?.name, 'scoped')
  })
})

describe('bad refs are config errors', () => {
  for (const key of ['matcherTable', 'moduleScope', 'globals'] as const) {
    test(`a relative ${key} ref is CONFIG_INVALID naming native.${key}`, async () => {
      const bad = { ...NATIVE, [key]: moduleRef('./native.mjs', key) }
      const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
      assert.match(error.message, new RegExp(`^native\\.${key}\\.module must be an absolute path`))
    })
  }

  test('a package specifier is refused as well, even for globals a project leaves off', async () => {
    const bad = { ...NATIVE, globals: moduleRef('@provino/api', 'provinoGlobals') }
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

  test('modules must be an array of specifiers', async () => {
    const bad = { ...NATIVE, modules: 'provino' as unknown as readonly string[] }
    const error = await rejectsWith(resolveProject({}, options(bad)), 'CONFIG_INVALID')
    assert.match(error.message, /^native\.modules must be an array/)
  })
})

function neutral(): NeutralProject {
  return {
    name: 'p',
    rootDir: temp.dir,
    discovery: {
      roots: [temp.dir],
      extensions: ['js'],
      includePatterns: { kind: 'glob', patterns: ['**/*.test.js'] },
      excludePatterns: ['/node_modules/'],
      crawlIgnorePatterns: [],
    },
    setupFiles: [],
    setupFilesAfterEnv: [],
    globalSetup: [],
    globalTeardown: [],
    environment: { name: 'node', options: {} },
    aliases: [],
    transforms: [],
    transformIgnorePatterns: [],
    snapshotSerializers: [],
    policy: {},
  }
}
