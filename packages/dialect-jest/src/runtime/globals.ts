// The Jest dialect's globals (T1.8's globals half; the rest of the `jest` object is T11.10/B13).
// The worker builds them once per worker from its own runtime: core's API, `expect`, and the
// registry of the file running now. Nothing here is module-level state.
import type { RuntimeApi, SuiteApi, TestApi } from '@provino/core'
import type { createExpect } from '@provino/expect'
import {
  createMockFn,
  isMockFunction,
  type Mock,
  type MockRegistry,
  type MockTarget,
  type Replaced,
  replaceProperty,
  type SpiedGetter,
  type SpiedMethod,
  type SpiedSetter,
  type SpyableKeys,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import type { FileRegistry, GlobalsHost } from '@provino/types'

/**
 * What `jestGlobals` builds the globals from: `GlobalsHost` with the real types of the
 * objects it declares as `object`. `GlobalsFactory` is bivariant in the host, so `jestGlobals`
 * is still a `GlobalsFactory`; through that type it accepts any host, so the worker must pass
 * the one it declares here.
 * @public
 */
export interface JestGlobalsHost extends GlobalsHost {
  /** Core's global API: `runtime.api`. */
  readonly api: RuntimeApi
  /** The worker's `expect`, from `createExpect`. */
  readonly expect: ReturnType<typeof createExpect>
  /** The mock registry of the file running now (the worker's, under isolation `none`). */
  mocks(): MockRegistry
}

/**
 * The `jest` global, as far as the worker runtime goes: the module registry methods, which act on
 * the registry of the file running when they are called. `isolateModules` and
 * `isolateModulesAsync` refuse to nest or overlap (on one registry), as Jest does. The mock
 * functions (`fn`, `spyOn`, `replaceProperty`, the three `*AllMocks`) act on the mock registry of
 * the file running. `jest.mock` and friends (B13c), timers (T4.9), `setTimeout`, `retryTimes` and
 * the rest of Jest's `jest` object are not here yet (T11.10).
 * @public
 */
export interface JestObject {
  /** Runs `fn` in an isolated module registry, then returns `jest`. */
  isolateModules(fn: () => void): JestObject
  /** Runs `fn` in an isolated module registry; resolves with nothing when `fn` has settled. */
  isolateModulesAsync(fn: () => Promise<void>): Promise<void>
  /** Forgets every module loaded so far in the file, then returns `jest`. */
  resetModules(): JestObject
  /** A mock function, running `impl` when it has one. */
  fn<T extends MockTarget = UnknownFunction>(impl?: T): Mock<T>
  /** Replaces a method with a spy that calls through. */
  spyOn<T extends object, K extends SpyableKeys<T>>(object: T, key: K): SpiedMethod<Required<T>[K]>
  /** Replaces an accessor's getter with a spy that calls through. */
  spyOn<T extends object, K extends keyof T>(object: T, key: K, access: 'get'): SpiedGetter<T[K]>
  /** Replaces an accessor's setter with a spy that calls through. */
  spyOn<T extends object, K extends keyof T>(object: T, key: K, access: 'set'): SpiedSetter<T[K]>
  /** Whether `value` is a mock function. */
  isMockFunction(value: unknown): value is Mock<UnknownFunction>
  /** Replaces a data property with `value` until `restore()` or `restoreAllMocks()`. */
  replaceProperty<T extends object, K extends keyof T>(
    object: T,
    key: K,
    value: T[K],
  ): Replaced<T[K]>
  /** `mockClear` on every mock, then returns `jest`. */
  clearAllMocks(): JestObject
  /** `mockReset` on every mock, then returns `jest`. */
  resetAllMocks(): JestObject
  /** Restores every spy and replaced property, then returns `jest`. */
  restoreAllMocks(): JestObject
}

/**
 * The globals Jest 30.5 injects into a test file, exactly: `jestDialect.globals.names` lists
 * these keys. A type alias, not an interface, so it is a `Readonly<Record<string, unknown>>`
 * like a `GlobalsFactory`'s result.
 * @public
 */
export type JestGlobals = {
  readonly afterAll: RuntimeApi['afterAll']
  readonly afterEach: RuntimeApi['afterEach']
  readonly beforeAll: RuntimeApi['beforeAll']
  readonly beforeEach: RuntimeApi['beforeEach']
  readonly describe: SuiteApi
  readonly expect: ReturnType<typeof createExpect>
  /** `describe.only`. */
  readonly fdescribe: SuiteApi
  /** `it.only`. */
  readonly fit: TestApi
  readonly it: TestApi
  readonly jest: JestObject
  readonly test: TestApi
  /** `describe.skip`. */
  readonly xdescribe: SuiteApi
  /** `it.skip`. */
  readonly xit: TestApi
  /** `test.skip`. */
  readonly xtest: TestApi
}

/**
 * Builds Jest 30.5's injected globals. `describe`, `it`, `test` and the four hooks are core's;
 * the `f` and `x` forms are core's `only` and `skip` modifiers; `expect` is the worker's. Each
 * call returns new objects, and the worker installs them on the environment's global.
 *
 * The `jest` object has `isolateModules`, `isolateModulesAsync` and `resetModules` (each reads
 * `host.registry()` when it is called, because every file has its own registry), and the mock
 * functions `fn`, `spyOn`, `isMockFunction`, `replaceProperty`, `clearAllMocks`, `resetAllMocks`
 * and `restoreAllMocks` (each reads `host.mocks()` and `host.mockPolicy` when it is called).
 * Nothing else.
 * @public
 */
export function jestGlobals(host: JestGlobalsHost): JestGlobals {
  const { api, expect } = host
  // The registries with an isolation running now. Jest keeps this on each file's module registries
  // (one set per file's runtime); a `FileRegistry` is the same scope here, so a `WeakSet` keyed by
  // it is the same record without a module-level one: every `jestGlobals` call (one per worker)
  // has its own, a file's registry can be collected with it, and one that never finishes (a hung
  // test) blocks only itself.
  const isolating = new WeakSet<FileRegistry>()

  /** Marks `registry` as isolating, or throws Jest's error when it already is. */
  const enterIsolation = (
    registry: FileRegistry,
    caller: 'isolateModules' | 'isolateModulesAsync',
  ): void => {
    if (isolating.has(registry)) {
      const other = caller === 'isolateModules' ? 'isolateModulesAsync' : 'isolateModules'
      // Jest 30.5.2, packages/jest-runtime/src/internals/ModuleRegistries.ts L125-L134
      // (`enterIsolated`, reached from `Runtime.isolateModules` and `isolateModulesAsync`,
      // src/index.ts L627-L643): copied exactly, a plain `Error` with no `code`, as Jest throws it.
      // unverified: read from source, not recorded (B14)
      throw new Error(`${caller} cannot be nested inside another ${caller} or ${other}.`)
    }
    isolating.add(registry)
  }

  const jest: JestObject = {
    isolateModules(fn) {
      const registry = host.registry()
      enterIsolation(registry, 'isolateModules')
      try {
        registry.isolateModules(fn)
      } finally {
        isolating.delete(registry)
      }
      // unverified: jest-runtime 30.5.2 `JestGlobals.ts` L267-L270 returns `jestObject`; read from source, not recorded
      return jest
    },
    async isolateModulesAsync(fn) {
      const registry = host.registry()
      enterIsolation(registry, 'isolateModulesAsync')
      try {
        // unverified: jest-runtime 30.5.2 `JestGlobals.ts` L271 hands back the runtime's `Promise<void>`; read from source, not recorded
        await registry.isolateModulesAsync(fn)
      } finally {
        isolating.delete(registry)
      }
    },
    resetModules() {
      host.registry().resetModules()
      // unverified: jest-runtime 30.5.2 `JestGlobals.ts` L263-L266 returns `jestObject`; read from source, not recorded
      return jest
    },
    fn<T extends MockTarget = UnknownFunction>(impl?: T): Mock<T> {
      return createMockFn<T>(
        host.mockPolicy,
        host.mocks(),
        impl === undefined ? undefined : { impl },
      )
    },
    // The engine's overloads take the access kind last; one signature serves all three.
    spyOn: ((object: object, key: PropertyKey, access?: 'get' | 'set'): unknown =>
      (spyOn as (...args: readonly unknown[]) => unknown)(
        host.mockPolicy,
        host.mocks(),
        object,
        key,
        access,
      )) as JestObject['spyOn'],
    isMockFunction(value: unknown): value is Mock<UnknownFunction> {
      return isMockFunction(host.mockPolicy, value)
    },
    replaceProperty<T extends object, K extends keyof T>(
      object: T,
      key: K,
      value: T[K],
    ): Replaced<T[K]> {
      return replaceProperty(host.mockPolicy, host.mocks(), object, key, value)
    },
    clearAllMocks() {
      host.mocks().clearAll()
      return jest
    },
    resetAllMocks() {
      host.mocks().resetAll()
      return jest
    },
    restoreAllMocks() {
      host.mocks().restoreAll()
      return jest
    },
  }
  return {
    afterAll: api.afterAll,
    afterEach: api.afterEach,
    beforeAll: api.beforeAll,
    beforeEach: api.beforeEach,
    describe: api.describe,
    expect,
    fdescribe: api.describe.only,
    fit: api.it.only,
    it: api.it,
    jest,
    test: api.test,
    xdescribe: api.describe.skip,
    xit: api.it.skip,
    xtest: api.test.skip,
  }
}
