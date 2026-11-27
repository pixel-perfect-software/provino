// The native API's values (D185, D186): built once per worker from its host, then served as the
// `provino` module to every module that imports it, installed in the `Symbol.for('provino.api')`
// slot for code the loader doesn't serve (a `node_modules` helper Node loads itself, which reaches
// the real `provino` entry's forwarders), and, under `globals: true`, installed as globals.
//
// Speed (D115): one object per worker, read from the host when the factory runs, so a served
// import is direct bindings with no Proxy and no per-call lookup; only the registries and the
// clock, which each file has its own of, are read when a member is called.

import type { FixtureTestApi } from '@provino/core'
import {
  evaluatedLazies,
  includeContext,
  includeExamples,
  itBehavesLike,
  LazyError,
  lazy,
  sharedContext,
  sharedExamples,
} from '@provino/lazy'
import {
  createMockFn,
  createStubs,
  isMockFunction,
  type Mock,
  type Mocked,
  type MockTarget,
  replaceProperty,
  type Stubs,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import { createTimerMembers } from '@provino/timers'
import { moduleMocksOver, PROVINO_MODULE_MOCK_NAMES } from './module-mocks.ts'
import { moduleRegistryOver } from './module-registry.ts'
import type {
  ApiHost,
  ProvinoApi,
  ProvinoGlobalsApi,
  ProvinoMocks,
  ProvinoSpyOn,
  ProvinoTimers,
} from './types.ts'

/**
 * The key the native API sits under on `globalThis`: the `provino` entry's forwarders read it
 * first, then the globals.
 * @public
 */
export const PROVINO_API_SLOT: unique symbol = Symbol.for('provino.api')

/**
 * The specifier the native runtime serves before resolution: `provino`'s `NATIVE_RUNTIME.modules`
 * and its hoist policy name the same one (`built-ins.test.ts` holds them equal).
 * @public
 */
export const PROVINO_SERVED_MODULE: 'provino' = 'provino'

/** The lazy variables: `provino`'s own exports, which read the lazy runtime's slot when called. */
const LAZY_EXPORTS = {
  evaluatedLazies,
  includeContext,
  includeExamples,
  itBehavesLike,
  LazyError,
  lazy,
  sharedContext,
  sharedExamples,
} as const

/** A host's API (in the slot) and the same values without the module-mock names (the globals). */
interface Built {
  readonly api: ProvinoApi
  readonly globals: ProvinoGlobalsApi
}

const builtByHost = new WeakMap<ApiHost, Built>()

/**
 * The stubs of one host's files, one set per file's mock registry, made on a file's first stub:
 * the registry's between-test steps (the policy's `unstubEnvs` and `unstubGlobals`) and its
 * dispose reach them. Stubs act on `process.env` and the global the test sees.
 */
function stubsOver(host: ApiHost): () => Stubs {
  const byRegistry = new WeakMap<object, Stubs>()
  return () => {
    const registry = host.mocks()
    let stubs = byRegistry.get(registry)
    if (stubs === undefined) {
      stubs = createStubs(registry, process.env, globalThis)
      byRegistry.set(registry, stubs)
    }
    return stubs
  }
}

function timersOver(host: ApiHost): ProvinoTimers {
  // `facadeReturns` comes from the host's policy (the neutral one says 'all': every member that
  // changes the clock returns this object), so the interface's types hold for the native runtime.
  const members = createTimerMembers(
    () => host.timers(),
    host.timersPolicy,
    () => timers,
  )
  const timers = Object.freeze({ ...members }) as unknown as ProvinoTimers
  return timers
}

function mocksOver(host: ApiHost): ProvinoMocks {
  return Object.freeze({
    clearAll: (): void => host.mocks().clearAll(),
    resetAll: (): void => host.mocks().resetAll(),
    restoreAll: (): void => host.mocks().restoreAll(),
  })
}

/** Builds the API once per host and installs its slot; a second call returns the same objects. */
function built(host: ApiHost): Built {
  const known = builtByHost.get(host)
  if (known !== undefined) return known
  const { api } = host
  const stubs = stubsOver(host)
  const made: ProvinoApi = Object.freeze({
    describe: api.describe,
    suite: api.suite,
    // The neutral policy exposes `extend` (`definitions.extendApi: 'expose'`), which core types apart.
    it: api.it as FixtureTestApi,
    test: api.test as FixtureTestApi,
    beforeAll: api.beforeAll,
    afterAll: api.afterAll,
    beforeEach: api.beforeEach,
    afterEach: api.afterEach,
    aroundEach: api.aroundEach,
    aroundAll: api.aroundAll,
    onTestFinished: api.onTestFinished,
    onTestFailed: api.onTestFailed,
    expect: host.expect,
    fn: <T extends MockTarget = UnknownFunction>(impl?: T): Mock<T> =>
      createMockFn<T>(host.mockPolicy, host.mocks(), impl === undefined ? undefined : { impl }),
    // The engine's overloads take the access kind last; one signature serves all three.
    spyOn: ((object: object, key: PropertyKey, access?: 'get' | 'set'): unknown =>
      (spyOn as (...args: readonly unknown[]) => unknown)(
        host.mockPolicy,
        host.mocks(),
        object,
        key,
        access,
      )) as ProvinoSpyOn,
    replaceProperty: <T extends object, K extends keyof T>(object: T, key: K, value: T[K]) =>
      replaceProperty(host.mockPolicy, host.mocks(), object, key, value),
    // The engine's stubs chain; native's return nothing, as `replaceProperty`'s siblings do.
    stubGlobal: (name: PropertyKey, value: unknown): void => void stubs().stubGlobal(name, value),
    stubEnv: (name: string, value: string | undefined): void => void stubs().stubEnv(name, value),
    unstubAllGlobals: (): void => void stubs().unstubAllGlobals(),
    unstubAllEnvs: (): void => void stubs().unstubAllEnvs(),
    isMockFunction: (value: unknown): value is Mock<UnknownFunction> =>
      isMockFunction(host.mockPolicy, value),
    // Jest's `mocked`: the value, retyped. The cast is the whole feature.
    mocked: <T>(value: T): Mocked<T> => value as Mocked<T>,
    mocks: mocksOver(host),
    timers: timersOver(host),
    ...moduleRegistryOver(host),
    ...moduleMocksOver(host, null),
  })
  // Configurable, so the worker's teardown (or a test) can take it out again.
  Object.defineProperty(globalThis, PROVINO_API_SLOT, {
    value: made,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  const globals: ProvinoGlobalsApi = Object.freeze(
    Object.fromEntries(
      Object.entries(made).filter(
        ([name]) => !(PROVINO_MODULE_MOCK_NAMES as readonly string[]).includes(name),
      ),
    ) as unknown as ProvinoGlobalsApi,
  )
  const result: Built = { api: made, globals }
  builtByHost.set(host, result)
  return result
}

/**
 * The served `provino` module's factory (`NativeRuntimeRefs.moduleScope`), called once per worker.
 * Each module that imports `provino` gets a frozen namespace of its own, the same one each time it
 * asks, holding the API and the lazy variables: every value is the worker's one object, so
 * `expect === expect` across a file's modules, except `mock`, `unmock`, `importActual` and `requireActual`,
 * which resolve a specifier from that module. It names no binding: a native file gets the API only
 * by importing it, or as globals under `globals: true`.
 * @public
 */
export function provinoModuleScope(host: ApiHost): ProvinoModuleScope {
  const { api } = built(host)
  // One namespace per importing module, built on its first import: `mock`, `unmock`,
  // `importActual` and `requireActual` resolve from that module; every other value is the worker's one object.
  const scopes = new Map<string, Readonly<Record<string, unknown>>>()
  const scopeOf = (from: string): Readonly<Record<string, unknown>> => {
    const known = scopes.get(from)
    if (known !== undefined) return known
    const namespace = Object.freeze({ ...api, ...moduleMocksOver(host, from), ...LAZY_EXPORTS })
    // The keys of the result are the binding names (none); the served module is not one of them.
    const scope: Readonly<Record<string, unknown>> = Object.freeze(
      Object.defineProperty({}, PROVINO_SERVED_MODULE, { value: namespace, enumerable: false }),
    )
    scopes.set(from, scope)
    return scope
  }
  // The worker disposes a disposable scope when it stops (the runner's `stop`), so the slot goes
  // with the worker: an inline pool shares its process with whatever runs next.
  return Object.assign(scopeOf, { [Symbol.dispose]: () => uninstallProvinoApi(api) })
}

/**
 * The served module's function, which the worker disposes as it stops (`uninstallProvinoApi`).
 * @public
 */
export type ProvinoModuleScope = ((from: string) => Readonly<Record<string, unknown>>) & Disposable

/**
 * Takes `api` out of the `provino.api` slot, only while the slot still holds it (a later worker's
 * API in the same process stays). Returns whether it did.
 * @public
 */
export function uninstallProvinoApi(api: ProvinoApi): boolean {
  if (Reflect.get(globalThis, PROVINO_API_SLOT) !== api) return false
  return Reflect.deleteProperty(globalThis, PROVINO_API_SLOT)
}

/**
 * The native API as globals (`NativeRuntimeRefs.globals`), used under `globals: true`: the same
 * objects the served module holds. The lazy variables and the module-mock names
 * (`ProvinoModuleMockName`) are never globals.
 * @public
 */
export function provinoGlobals(host: ApiHost): ProvinoGlobalsApi {
  return built(host).globals
}
