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
  isMockFunction,
  type Mock,
  type MockTarget,
  replaceProperty,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import { createTimerMembers } from '@provino/timers'
import type { ApiHost, ProvinoApi, ProvinoMocks, ProvinoSpyOn, ProvinoTimers } from './types.ts'

/**
 * The key the native API sits under on `globalThis`: the `provino` entry's forwarders read it
 * first, then the globals.
 * @public
 */
export const PROVINO_API_SLOT: unique symbol = Symbol.for('provino.api')

/** The specifier the native runtime serves before resolution (`NativeRuntimeRefs.modules`). */
const SERVED = 'provino'

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

const builtByHost = new WeakMap<ApiHost, ProvinoApi>()

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

/** Builds the API once per host and installs its slot; a second call returns the same object. */
function built(host: ApiHost): ProvinoApi {
  const known = builtByHost.get(host)
  if (known !== undefined) return known
  const { api } = host
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
    isMockFunction: (value: unknown): value is Mock<UnknownFunction> =>
      isMockFunction(host.mockPolicy, value),
    mocks: mocksOver(host),
    timers: timersOver(host),
  })
  // Configurable, so the worker's teardown (or a test) can take it out again.
  Object.defineProperty(globalThis, PROVINO_API_SLOT, {
    value: made,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  builtByHost.set(host, made)
  return made
}

/**
 * The served `provino` module's factory (`NativeRuntimeRefs.moduleScope`), called once per worker:
 * every module that imports `provino` gets the same frozen namespace (the API and the lazy
 * variables), so `expect === expect` across a file's modules. It names no binding: a native file
 * gets the API only by importing it, or as globals under `globals: true`.
 * @public
 */
export function provinoModuleScope(host: ApiHost): ProvinoModuleScope {
  const api = built(host)
  const namespace = Object.freeze({ ...api, ...LAZY_EXPORTS })
  // The keys of the result are the binding names (none); the served module is not one of them.
  const scope: Readonly<Record<string, unknown>> = Object.freeze(
    Object.defineProperty({}, SERVED, { value: namespace, enumerable: false }),
  )
  // The worker disposes a disposable scope when it stops (the runner's `stop`), so the slot goes
  // with the worker: an inline pool shares its process with whatever runs next.
  return Object.assign(() => scope, { [Symbol.dispose]: () => uninstallProvinoApi(api) })
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
 * objects the served module holds. The lazy variables are never globals.
 * @public
 */
export function provinoGlobals(host: ApiHost): ProvinoApi {
  return built(host)
}
