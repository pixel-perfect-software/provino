// B27a: the keys `provino.config.*` gains for the native runtime (Phase 4 gives them behaviour),
// `ProvinoConfig` (what `defineConfig` takes) and `NativeRuntimeRefs` (D186).
import type {
  CloneSafe,
  ConfigEnv,
  ConfigResolve,
  ConfigTimeouts,
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
  projects: [
    'packages/*',
    { name: 'inline', include: ['test/**/*.test.ts'], timeouts: { test: 1 } },
  ],
}
expectTypeOf(full).toExtend<ProvinoConfig>()

expectTypeOf<ProvinoConfigInput['timeouts']>().toEqualTypeOf<ConfigTimeouts | undefined>()
expectTypeOf<ProvinoConfigInput['resolve']>().toEqualTypeOf<ConfigResolve | undefined>()
expectTypeOf<ProvinoConfigInput['pool']>().toEqualTypeOf<PoolKind | undefined>()
expectTypeOf<ConfigResolve['tsconfig']>().toEqualTypeOf<'auto' | false | string | undefined>()
expectTypeOf<
  'timeouts' | 'resolve' | 'environmentOptions' | 'pool' | 'maxWorkers'
>().toExtend<ReservedConfigKey>()
// A project's own keys cover the per-project ones; the run's keys are the top level's only.
expectTypeOf<ProjectConfig>().toHaveProperty('timeouts')
expectTypeOf<ProjectConfig>().toHaveProperty('resolve')
expectTypeOf<ProjectConfig>().not.toHaveProperty('pool')
expectTypeOf<ProjectConfig>().not.toHaveProperty('projects')

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
