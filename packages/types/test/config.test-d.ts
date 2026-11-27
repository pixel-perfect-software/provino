// B27a: the keys `provino.config.*` gains for the native runtime (Phase 4 gives them behaviour),
// `ProvinoConfig` (what `defineConfig` takes) and `NativeRuntimeRefs` (D186).
import type {
  CloneSafe,
  ConfigCoverage,
  ConfigEnv,
  ConfigResolve,
  ConfigTimeouts,
  CoverageReporterName,
  GlobalsFactory,
  MatcherTableFactory,
  ModuleRef,
  ModuleScopeFactory,
  NativeRuntimeRefs,
  PoolKind,
  ProjectConfig,
  ProvinoConfig,
  ProvinoConfigInput,
  ReservedConfigKey,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

const full: ProvinoConfigInput = {
  include: ['src/**/*.test.ts'],
  setupFiles: ['./setup.ts', '@testing-library/jest-dom'],
  environmentOptions: { url: 'http://localhost/' },
  timeouts: { test: 120_000, hook: 120_000, teardown: 10_000 },
  resolve: {
    conditions: ['provino-source'],
    aliases: { '@/*': './src/*' },
    tsconfig: './tsconfig.test.json',
  },
  pool: 'forks',
  maxWorkers: 4,
  execArgv: ['--conditions=provino-source'],
  projects: [
    'packages/*',
    { name: 'inline', include: ['test/**/*.test.ts'], timeouts: { test: 1 } },
  ],
}
expectTypeOf(full).toExtend<ProvinoConfig>()

expectTypeOf<ProvinoConfigInput['timeouts']>().toEqualTypeOf<ConfigTimeouts | undefined>()
expectTypeOf<ProvinoConfigInput['resolve']>().toEqualTypeOf<ConfigResolve | undefined>()
expectTypeOf<ProvinoConfigInput['pool']>().toEqualTypeOf<PoolKind | undefined>()
// `'auto'` stays a member of its own: `'auto' | false | string` would collapse to `false | string`.
expectTypeOf<ConfigResolve['tsconfig']>().toEqualTypeOf<
  'auto' | false | (string & {}) | undefined
>()
expectTypeOf<ConfigResolve['tsconfig']>().not.toEqualTypeOf<false | string | undefined>()
expectTypeOf<
  'timeouts' | 'resolve' | 'environmentOptions' | 'pool' | 'maxWorkers' | 'execArgv'
>().toExtend<ReservedConfigKey>()
// A project's own keys cover the per-project ones; the run's keys are the top level's only.
expectTypeOf<ProjectConfig>().toHaveProperty('timeouts')
expectTypeOf<ProjectConfig>().toHaveProperty('resolve')
expectTypeOf<ProjectConfig>().not.toHaveProperty('pool')
expectTypeOf<ProjectConfig>().not.toHaveProperty('projects')
expectTypeOf<ProjectConfig>().not.toHaveProperty('execArgv')
expectTypeOf<ProvinoConfigInput['execArgv']>().toEqualTypeOf<readonly string[] | undefined>()

// `ProvinoConfig` is the config or a (maybe async) function of the env that returns one.
const asFunction: ProvinoConfig = (env: ConfigEnv) => ({ include: [env.mode] })
const asAsync: ProvinoConfig = async () => ({ timeouts: { test: 1 } })
expectTypeOf(asFunction).toExtend<ProvinoConfig>()
expectTypeOf(asAsync).toExtend<ProvinoConfig>()

// @ts-expect-error a timeout is a number of ms
const stringTimeout: ProvinoConfigInput = { timeouts: { test: '5s' } }
// @ts-expect-error `timeouts` is an object of three, not one number
const numberTimeouts: ProvinoConfigInput = { timeouts: 5000 }
// @ts-expect-error `resolve.conditions` is an array of strings
const oneCondition: ProvinoConfigInput = { resolve: { conditions: 'provino-source' } }
// @ts-expect-error an alias maps to a path string
const aliasArray: ProvinoConfigInput = { resolve: { aliases: { '@/*': ['./src/*'] } } }
// @ts-expect-error an inline project has no `projects` of its own
const nested: ProvinoConfigInput = { projects: [{ name: 'a', projects: ['b'] }] }
// @ts-expect-error `pool` is a run key: an inline project can't set it
const projectPool: ProvinoConfigInput = { projects: [{ name: 'a', pool: 'forks' }] }
// @ts-expect-error a pool is forks, threads or inline
const badPool: ProvinoConfigInput = { pool: 'workers' }
// @ts-expect-error environment options are JSON, so a function is out
const closureOptions: ProvinoConfigInput = { environmentOptions: { onSetup: () => {} } }

// The native refs are refs, so they cross to a worker; a closure is never one.
declare const tableRef: ModuleRef<MatcherTableFactory>
declare const scopeRef: ModuleRef<ModuleScopeFactory>
declare const globalsRef: ModuleRef<GlobalsFactory>
const native: NativeRuntimeRefs = {
  matcherTable: tableRef,
  moduleScope: scopeRef,
  modules: ['provino'],
  globals: globalsRef,
}
expectTypeOf(native).toExtend<CloneSafe<NativeRuntimeRefs>>()
const withDefaults: NativeRuntimeRefs = {
  ...native,
  environmentOptions: { jsdom: { standIns: true } },
}
expectTypeOf(withDefaults).toExtend<CloneSafe<NativeRuntimeRefs>>()
const closureDefaults: NativeRuntimeRefs = {
  ...native,
  // @ts-expect-error an environment's options are JSON
  environmentOptions: { jsdom: { x: () => 1 } },
}
// @ts-expect-error the matcher table crosses by ref, not as the factory itself
const closureTable: NativeRuntimeRefs = { ...native, matcherTable: () => ({}) }
// @ts-expect-error the served modules are named
const noModules: NativeRuntimeRefs = {
  matcherTable: tableRef,
  moduleScope: scopeRef,
  globals: globalsRef,
}

export {
  aliasArray,
  badPool,
  closureDefaults,
  closureOptions,
  closureTable,
  full,
  nested,
  noModules,
  numberTimeouts,
  oneCondition,
  projectPool,
  stringTimeout,
}

// B28: the top-level `coverage` key, the run's own.
const coverage: ConfigCoverage = {
  enabled: true,
  provider: 'istanbul',
  include: ['src/**/*.ts', '!src/skip.ts'],
  exclude: ['src/gen/**'],
  reporters: ['text', ['lcov', { projectRoot: '/x' }]],
  directory: 'coverage',
  thresholds: { global: { lines: 80, branches: -2 }, 'src/a.ts': { statements: 100 } },
}
expectTypeOf({ coverage }).toExtend<ProvinoConfigInput>()
expectTypeOf<ProvinoConfigInput['coverage']>().toEqualTypeOf<ConfigCoverage | undefined>()
expectTypeOf<ProjectConfig>().not.toHaveProperty('coverage')
expectTypeOf<'coverage'>().toExtend<ReservedConfigKey>()
expectTypeOf<'lcovonly' | 'text-summary' | 'html-spa'>().toExtend<CoverageReporterName>()
// @ts-expect-error not a provider
const _badProvider: ConfigCoverage = { provider: 'babel' }
// @ts-expect-error not an istanbul-reports reporter
const _badReporter: ConfigCoverage = { reporters: ['lcovv'] }
// @ts-expect-error not a coverage metric
const _badMetric: ConfigCoverage = { thresholds: { global: { paths: 80 } } }
// @ts-expect-error a threshold is a number
const _badThreshold: ConfigCoverage = { thresholds: { global: { lines: '80' } } }
// @ts-expect-error not a key of coverage
const _badKey: ConfigCoverage = { reporter: ['text'] }
