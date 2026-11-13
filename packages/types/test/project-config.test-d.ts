// B10's contract seams: what a worker is started with (`SerializedProjectConfig`), the globals a
// dialect builds from the worker's runtime, `FileRegistry.invalidate`, and the matcher a
// `SerializedError` names.
import type {
  CloneSafe,
  CorePolicy,
  DefaultRetry,
  Dialect,
  Environment,
  EnvironmentRef,
  FileRegistry,
  GlobalsFactory,
  GlobalsHost,
  HoistPolicy,
  JsonValue,
  MockPolicy,
  ModuleId,
  ModuleMapper,
  ModuleMapperFactory,
  ModuleMockRegistry,
  ModuleRef,
  ModuleScope,
  ModuleScopeFactory,
  SerializedError,
  SerializedLoaderConfig,
  SerializedModuleMapper,
  SerializedPolicy,
  SerializedProjectConfig,
  SerializedTransformConfig,
  WorkerInit,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const policy: SerializedPolicy
declare const registry: FileRegistry
declare const globalsRef: ModuleRef<GlobalsFactory>
declare const mapperRef: ModuleRef<ModuleMapperFactory>
declare const closureMapperFactory: ModuleMapperFactory

declare const hoist: HoistPolicy
declare const scopeRef: ModuleRef<ModuleScopeFactory>

const loader: SerializedLoaderConfig = {
  hoist,
  moduleScope: ['jest'],
  extensions: ['.ts', '.js'],
  conditions: ['node'],
  tsconfig: 'auto',
  mappers: [{ factory: mapperRef, options: { from: '@/', to: './src/' } }],
  typescript: 'oxc',
}
const environment: EnvironmentRef = {
  module: '@provino/env-node',
  export: 'nodeEnvironment',
  options: {},
}
const config: SerializedProjectConfig = {
  name: 'app',
  rootDir: '/repo',
  ci: false,
  seed: 1,
  policy,
  environment,
  globals: globalsRef,
  moduleScope: scopeRef,
  setupFiles: ['/repo/setup.ts'],
  setupFilesAfterEnv: [],
  loader,
}

// B13c: the hoist policy crosses by value (data, `RegExp` and `Set` leaves), and the per-module
// bindings as names plus a factory ref.
expectTypeOf<SerializedLoaderConfig['hoist']>().toEqualTypeOf<HoistPolicy | null>()
expectTypeOf<HoistPolicy>().toExtend<CloneSafe<HoistPolicy>>()
expectTypeOf<SerializedLoaderConfig['moduleScope']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<
  SerializedProjectConfig['moduleScope']
>().toEqualTypeOf<ModuleRef<ModuleScopeFactory> | null>()
const noScope: SerializedProjectConfig = { ...config, moduleScope: null }
// @ts-expect-error a factory crosses by ref, never as a closure
const closureScope: SerializedProjectConfig = { ...config, moduleScope: () => () => ({}) }
// @ts-expect-error the loader config needs its hoist key, `null` for none
const noHoist: SerializedLoaderConfig = { ...loader, hoist: undefined }
declare const scopeHost: GlobalsHost
declare const scopeFactory: ModuleScopeFactory
expectTypeOf(scopeFactory(scopeHost)).toEqualTypeOf<
  (from: string) => Readonly<Record<string, unknown>>
>()
expectTypeOf<Dialect['moduleScope']>().toEqualTypeOf<ModuleScope | undefined>()
expectTypeOf(scopeHost.moduleMocks()).toEqualTypeOf<ModuleMockRegistry>()

// What crosses to the worker is clone-safe, all the way down.
expectTypeOf<SerializedProjectConfig>().toExtend<CloneSafe<SerializedProjectConfig>>()
expectTypeOf<SerializedLoaderConfig>().toExtend<CloneSafe<SerializedLoaderConfig>>()
expectTypeOf<EnvironmentRef>().toExtend<CloneSafe<EnvironmentRef>>()
expectTypeOf<SerializedModuleMapper>().toExtend<CloneSafe<SerializedModuleMapper>>()
expectTypeOf<WorkerInit>().toExtend<CloneSafe<WorkerInit>>()
expectTypeOf<WorkerInit['config']>().toEqualTypeOf<SerializedProjectConfig>()
expectTypeOf<SerializedProjectConfig['globals']>().toEqualTypeOf<ModuleRef<GlobalsFactory> | null>()
expectTypeOf<SerializedProjectConfig['policy']>().toEqualTypeOf<SerializedPolicy>()
expectTypeOf<EnvironmentRef['options']>().toEqualTypeOf<{ readonly [key: string]: JsonValue }>()

// Parts that can't cross a thread are not clone-safe.
expectTypeOf<SerializedProjectConfig & { readonly onTeardown: () => void }>().not.toExtend<
  CloneSafe<SerializedProjectConfig & { readonly onTeardown: () => void }>
>()
expectTypeOf<{
  readonly module: string
  readonly export: string
  readonly options: { readonly f: () => void }
}>().not.toExtend<
  CloneSafe<{
    readonly module: string
    readonly export: string
    readonly options: { readonly f: () => void }
  }>
>()
expectTypeOf<{ readonly factory: ModuleMapperFactory; readonly options: JsonValue }>().not.toExtend<
  CloneSafe<{ readonly factory: ModuleMapperFactory; readonly options: JsonValue }>
>()
expectTypeOf<ModuleMapper>().not.toExtend<CloneSafe<ModuleMapper>>()
expectTypeOf<Environment>().not.toExtend<CloneSafe<Environment>>()

// @ts-expect-error a closure can't be the globals factory: it is a ref
const closureGlobals: SerializedProjectConfig = { ...config, globals: () => ({}) }
// @ts-expect-error `globals` is a ref or null, never left out
const noGlobals: SerializedProjectConfig = { ...config, globals: undefined }
// @ts-expect-error the environment is a ref to a value, not the Environment itself
const wholeEnvironment: SerializedProjectConfig = { ...config, environment: {} as Environment }
// @ts-expect-error environment options are JSON, so a function is out
const closureOptions: EnvironmentRef = { ...environment, options: { onSetup: () => {} } }
// @ts-expect-error a mapper has methods and can't cross: give its factory's ref
const mapperObject: SerializedModuleMapper = { factory: {} as ModuleMapper, options: null }
const closureFactory: SerializedModuleMapper = {
  // @ts-expect-error a closure factory isn't a ModuleRef either
  factory: closureMapperFactory,
  options: null,
}
// @ts-expect-error `tsconfig` is 'auto', false or a path
const badTsconfig: SerializedLoaderConfig = { ...loader, tsconfig: true }
// @ts-expect-error only the transform pipeline's modes
const badTypescript: SerializedLoaderConfig = { ...loader, typescript: 'swc' }
// @ts-expect-error a Jest `custom` resolver has a closure, so it isn't part of the loader config
const customResolver: SerializedLoaderConfig = { ...loader, custom: () => '' }
// @ts-expect-error a worker is started with a config, not null
const nullConfig: WorkerInit = { ...({} as WorkerInit), config: null }
// @ts-expect-error every field is there
const missingField: SerializedProjectConfig = { name: 'app' }

// A dialect's globals: a factory by ref, and the names it returns.
declare const dialect: Dialect
expectTypeOf(dialect.globals).toEqualTypeOf<
  { readonly factory: ModuleRef<GlobalsFactory>; readonly names: readonly string[] } | undefined
>()
const withGlobals: Dialect = {
  ...dialect,
  globals: { factory: globalsRef, names: ['describe', 'it', 'expect'] },
}
// @ts-expect-error the old `{ module, names }` shape had no way to reach the worker's runtime
const oldShape: Dialect = { ...dialect, globals: { module: '@scope/globals', names: [] } }
// @ts-expect-error a closure can't be the factory: it must cross to the worker as a ref
const closureFactoryGlobals: Dialect = { ...dialect, globals: { factory: () => ({}), names: [] } }

// The host is what a dialect builds its globals from.
declare const host: GlobalsHost
expectTypeOf(host.api).toEqualTypeOf<object>()
expectTypeOf(host.expect).toEqualTypeOf<object>()
expectTypeOf(host.registry).toEqualTypeOf<() => FileRegistry>()
expectTypeOf(host.mocks).toEqualTypeOf<() => object>()
expectTypeOf(host.mockPolicy).toEqualTypeOf<MockPolicy>()
// The retry a file sets for its tests (`jest.retryTimes`), or none: a count and a delay, and the
// policy's `timing` and `keepEarlierErrors` when the file sets them.
expectTypeOf(host.setDefaultRetry).toEqualTypeOf<(retry: DefaultRetry | undefined) => void>()
expectTypeOf<DefaultRetry>().toEqualTypeOf<{
  readonly count: number
  readonly delay: number
  readonly timing?: 'deferred' | 'immediate'
  readonly keepEarlierErrors?: boolean
}>()
expectTypeOf<DefaultRetry['timing']>().toEqualTypeOf<CorePolicy['retry']['timing'] | undefined>()
host.setDefaultRetry({ count: 1, delay: 0, timing: 'immediate', keepEarlierErrors: true })
// @ts-expect-error a retry with no `delay` is incomplete
host.setDefaultRetry({ count: 1 })
// @ts-expect-error `timing` is one of the policy's two
host.setDefaultRetry({ count: 1, delay: 0, timing: 'soon' })
expectTypeOf<GlobalsFactory>().returns.toEqualTypeOf<Readonly<Record<string, unknown>>>()
expectTypeOf<ReturnType<GlobalsFactory>>().toEqualTypeOf<Readonly<Record<string, unknown>>>()

// A factory may declare a narrower host (core's and expect's real types): bivariant in the host.
interface NarrowHost extends GlobalsHost {
  readonly api: { readonly describe: (name: string, fn: () => void) => void }
  readonly expect: (actual: unknown) => { toBe(expected: unknown): void }
}
const narrow: GlobalsFactory = (narrowHost: NarrowHost) => ({
  describe: narrowHost.api.describe,
  expect: narrowHost.expect,
})
const wide: GlobalsFactory = (wideHost: GlobalsHost) => ({ registry: wideHost.registry })
// A factory for an unrelated host is still rejected.
// @ts-expect-error not a host
const unrelated: GlobalsFactory = (notAHost: string) => ({ notAHost })
// @ts-expect-error it must return a record of globals
const returnsNothing: GlobalsFactory = (_host: GlobalsHost) => undefined
// The ref carries the factory's type.
expectTypeOf<ModuleRef<GlobalsFactory>['__fn']>().toEqualTypeOf<GlobalsFactory | undefined>()

// `FileRegistry.invalidate` takes a specifier, and the importing module when it isn't the test file.
expectTypeOf(registry.invalidate).parameters.toEqualTypeOf<
  [specifier: string, parent?: ModuleId | null | undefined]
>()
expectTypeOf(registry.invalidate).returns.toEqualTypeOf<void>()
registry.invalidate('./setup.ts')
registry.invalidate('./setup.ts', null)
registry.invalidate('./setup.ts', '/repo/a.ts' as ModuleId)
// @ts-expect-error a specifier is a string
registry.invalidate(1)
// @ts-expect-error ModuleId is branded
registry.invalidate('./setup.ts', '/repo/a.ts')

// A serialized error names the matcher that failed and whether it passed, and nothing else.
expectTypeOf<SerializedError['matcherResult']>().toEqualTypeOf<
  { readonly name: string; readonly pass: boolean } | undefined
>()
expectTypeOf<SerializedError>().toExtend<CloneSafe<SerializedError>>()
const failed: SerializedError = {
  name: 'Error',
  message: 'm',
  matcherResult: { name: 'toBe', pass: false },
}
// @ts-expect-error `pass` is required
const noPass: SerializedError = { name: 'Error', message: 'm', matcherResult: { name: 'toBe' } }
const wholeResult: SerializedError = {
  name: 'Error',
  message: 'm',
  // @ts-expect-error the result's message, actual and expected stay behind
  matcherResult: { name: 'toBe', pass: false, message: 'm' },
}
// @ts-expect-error exactOptionalPropertyTypes: omitted, not undefined
const undefinedResult: SerializedError = { name: 'Error', message: 'm', matcherResult: undefined }

export {
  badTsconfig,
  badTypescript,
  closureFactory,
  closureFactoryGlobals,
  closureGlobals,
  closureOptions,
  closureScope,
  customResolver,
  failed,
  mapperObject,
  missingField,
  narrow,
  noGlobals,
  noHoist,
  noPass,
  noScope,
  nullConfig,
  oldShape,
  returnsNothing,
  undefinedResult,
  unrelated,
  wholeEnvironment,
  wholeResult,
  wide,
  withGlobals,
}

// T3.8: user transformers cross as refs plus JSON options.
declare const transformerRef: ModuleRef
const withTransform: SerializedLoaderConfig = {
  ...loader,
  transform: {
    rules: [{ pattern: '\\.tsx?$', transformer: transformerRef, options: { tsconfig: 'a.json' } }],
    ignorePatterns: ['/node_modules/'],
    config: { rootDir: '/repo', globals: {} },
    hoistedMarkers: ['_getJestObj'],
  },
}
expectTypeOf(withTransform).toExtend<CloneSafe<SerializedLoaderConfig>>()
expectTypeOf(loader.transform).toEqualTypeOf<SerializedTransformConfig | undefined>()
export const fnTransformer: SerializedLoaderConfig = {
  ...loader,
  transform: {
    // @ts-expect-error a transformer is a ref, not a function (D21)
    rules: [{ pattern: 'a', transformer: () => ({}), options: {} }],
    ignorePatterns: [],
    config: {},
    hoistedMarkers: [],
  },
}
