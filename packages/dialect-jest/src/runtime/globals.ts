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
import {
  createTimerMembers,
  type FakeClock,
  type FakeTimersConfig,
  type TimerMembers,
} from '@provino/timers'
import type {
  FileRegistry,
  GlobalsHost,
  MockFactory,
  MockSpec,
  ModuleId,
  TimersPolicy,
} from '@provino/types'

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
  /** The fake clock of the file running now, on the environment's global. */
  timers(): FakeClock
  /** The `timers` slice of the policy: what the timer members follow. */
  readonly timersPolicy: TimersPolicy
}

/**
 * What `jest.useFakeTimers` takes (Jest's `fakeTimers` config): which globals stay real, whether
 * the clock advances with real time, the loop limit, the start time. `legacyFakeTimers: true` is
 * refused when a test installs it (`TIMERS_LEGACY_UNSUPPORTED`).
 * @public
 */
export type JestFakeTimersConfig = Pick<
  FakeTimersConfig,
  'now' | 'doNotFake' | 'advanceTimers' | 'timerLimit' | 'legacyFakeTimers'
>

/**
 * The timer members of `jest` (jest-runtime 30.5.2 `JestGlobals.ts`), over the fake clock of the file
 * running now. `J` is the object a chained call returns: the global `jest`, or a module's.
 * `useFakeTimers`, `useRealTimers` and `setTimerTickMode` return it (`facadeReturns: 'lifecycle'`);
 * the rest return nothing.
 * @public
 */
export interface JestTimerMembers<J> {
  /** Fakes the environment's timers; a second call drops the pending timers first. */
  useFakeTimers(config?: JestFakeTimersConfig): J
  /** Puts the real timers back. */
  useRealTimers(): J
  /** Runs every timer until none is left (at most `timerLimit`). */
  runAllTimers(): void
  runAllTimersAsync(): Promise<void>
  /** Runs the timers that are pending now, and none a callback adds. */
  runOnlyPendingTimers(): void
  runOnlyPendingTimersAsync(): Promise<void>
  /** Moves the clock forward by `msToRun`, firing the timers that fall due. */
  advanceTimersByTime(msToRun: number): void
  advanceTimersByTimeAsync(msToRun: number): Promise<void>
  /** Moves the clock to the next `steps` timers (default one). */
  advanceTimersToNextTimer(steps?: number): void
  advanceTimersToNextTimerAsync(steps?: number): Promise<void>
  /** Moves the clock to the next 16 ms animation frame. */
  advanceTimersToNextFrame(): void
  /** Runs the jobs a faked `process.nextTick` or `queueMicrotask` queued. */
  runAllTicks(): void
  /** Drops every pending timer. */
  clearAllTimers(): void
  /** How many timers are pending. */
  getTimerCount(): number
  /** The fake time while timers are fake, else `Date.now()`. */
  now(): number
  /** Sets the fake time without firing a timer. */
  setSystemTime(now?: number | Date): void
  /** `Date.now()` as it was before any install. */
  getRealSystemTime(): number
  /** How the fake clock moves on its own. */
  setTimerTickMode(mode: { mode: 'manual' | 'nextAsync' } | { mode: 'interval'; delta?: number }): J
  /** Legacy timers only: always throws, because Provino has no legacy timers. */
  runAllImmediates(): void
}

/**
 * What `jest.retryTimes` takes.
 * @public
 */
export interface JestRetryOptions {
  readonly logErrorsBeforeRetry?: boolean
  readonly retryImmediately?: boolean
  readonly waitBeforeRetry?: number
  readonly entireDescribe?: boolean
}

/**
 * The `jest` global, as far as the worker runtime goes: the module registry methods, which act on
 * the registry of the file running when they are called. `isolateModules` and
 * `isolateModulesAsync` refuse to nest or overlap (on one registry), as Jest does. The mock
 * functions (`fn`, `spyOn`, `replaceProperty`, the three `*AllMocks`) act on the mock registry of
 * the file running. `jest.mock` and friends (B13c) are on each module's own `jest`
 * (`JestModuleObject`); `retryTimes` is refused until deferred retries exist (T5.10).
 * @public
 */
export interface JestObject extends JestTimerMembers<JestObject> {
  /** Runs `fn` in an isolated module registry, then returns `jest`. */
  isolateModules(fn: () => void): JestObject
  /** Runs `fn` in an isolated module registry; resolves with nothing when `fn` has settled. */
  isolateModulesAsync(fn: () => Promise<void>): Promise<void>
  /** Forgets every module loaded so far in the file, then returns `jest`. */
  resetModules(): JestObject
  /**
   * Sets the timeout a test or hook with none of its own gets, until this file ends: the tests
   * already declared included (jest-circus reads it when a test runs). `0` leaves the default.
   */
  setTimeout(timeout: number): JestObject
  /**
   * Refused: Jest retries after the file's other tests (deferred retries, T5.10), which the core
   * does not run yet. Throws, naming the task.
   */
  retryTimes(numRetries: number, options?: JestRetryOptions): JestObject
  /** The run's random seed (`--seed`, else one drawn per run), the same on every call. */
  getSeed(): number
  /** Whether the file's environment has been torn down: true for a callback that outlives its file. */
  isEnvironmentTornDown(): boolean
  /** The argument, typed as mocked (jest-mock's `mocked` is the identity). */
  mocked<T>(item: T): T
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
 * `jest.mock`'s options: `virtual` lets the module not exist on disk.
 * @public
 */
export interface JestMockOptions {
  readonly virtual?: boolean
}

/**
 * The `jest` each module gets as its own binding (B13c, as jest-runtime's
 * `_createJestObjectFor(from)`): the global's members, plus the module-mock calls, which resolve
 * from the module that makes them. Every chained call returns this module's object.
 * @public
 */
export interface JestModuleObject extends JestObject {
  useFakeTimers(config?: JestFakeTimersConfig): JestModuleObject
  useRealTimers(): JestModuleObject
  setTimerTickMode(
    mode: { mode: 'manual' | 'nextAsync' } | { mode: 'interval'; delta?: number },
  ): JestModuleObject
  /** Mocks `moduleName` for this file, hoisted above the imports: by `factory`, a manual mock, or an automock. */
  mock(moduleName: string, factory?: () => unknown, options?: JestMockOptions): JestModuleObject
  /** `mock`, not hoisted. */
  doMock(moduleName: string, factory?: () => unknown, options?: JestMockOptions): JestModuleObject
  /** The real module from now on (hoisted). */
  unmock(moduleName: string): JestModuleObject
  /** `unmock`, not hoisted. */
  dontMock(moduleName: string): JestModuleObject
  /** Replaces `moduleName` for this file with `moduleExports`, as an explicit mock (jest-runtime `setMock`). */
  setMock(moduleName: string, moduleExports: unknown): JestModuleObject
  /** `unmock`: the module and what it imports are real again (Provino unmocks the module itself). */
  deepUnmock(moduleName: string): JestModuleObject
  /** The real module, whatever is mocked: its own imports still see the mocks. */
  requireActual<T = unknown>(moduleName: string): T
  /** The mocked module, whether or not it is registered: a manual mock, else an automock. */
  requireMock<T = unknown>(moduleName: string): T
  /** An automock of the real module, built now and not registered. */
  createMockFromModule<T = unknown>(moduleName: string): T
  /** Every module the file loads from now on is automocked, unless it is unmocked. */
  enableAutomock(): JestModuleObject
  disableAutomock(): JestModuleObject
  isolateModules(fn: () => void): JestModuleObject
  resetModules(): JestModuleObject
  setTimeout(timeout: number): JestModuleObject
  retryTimes(numRetries: number, options?: JestRetryOptions): JestModuleObject
  /** `enableAutomock`. */
  autoMockOn(): JestModuleObject
  /** `disableAutomock`. */
  autoMockOff(): JestModuleObject
  /**
   * Runs `callback` on every automock built from now on, with the module's resolved path and the
   * mock; what it returns is the mock (each callback gets the one before's result).
   */
  onGenerateMock<T>(callback: (moduleName: string, moduleMock: T) => T): JestModuleObject
  /** `doMock` for a module the file imports natively: the factory is required. */
  unstable_mockModule(
    moduleName: string,
    factory: () => unknown,
    options?: JestMockOptions,
  ): JestModuleObject
  /** `dontMock`, for `unstable_mockModule`. */
  unstable_unmockModule(moduleName: string): JestModuleObject
  clearAllMocks(): JestModuleObject
  resetAllMocks(): JestModuleObject
  restoreAllMocks(): JestModuleObject
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

/** The registries with an isolation running now (see `jestGlobals`). */
type Isolating = WeakSet<FileRegistry>

/** Marks `registry` as isolating, or throws Jest's error when it already is. */
function enterIsolation(
  isolating: Isolating,
  registry: FileRegistry,
  caller: 'isolateModules' | 'isolateModulesAsync',
): void {
  if (isolating.has(registry)) {
    const other = caller === 'isolateModules' ? 'isolateModulesAsync' : 'isolateModules'
    // Jest 30.5.2, packages/jest-runtime/src/internals/ModuleRegistries.ts L125-L134
    // (`enterIsolated`, reached from `Runtime.isolateModules` and `isolateModulesAsync`,
    // src/index.ts L627-L643): copied exactly, a plain `Error` with no `code`, as Jest throws it.
    // Recorded: `policy/jest-object-returns` (the nested call's text).
    throw new Error(`${caller} cannot be nested inside another ${caller} or ${other}.`)
  }
  isolating.add(registry)
}

/** The members the global `jest` and every module's own share; a chained call returns `J`. */
interface SharedMembers<J> extends JestTimerMembers<J> {
  isolateModules(fn: () => void): J
  isolateModulesAsync(fn: () => Promise<void>): Promise<void>
  resetModules(): J
  readonly fn: JestObject['fn']
  readonly spyOn: JestObject['spyOn']
  readonly isMockFunction: JestObject['isMockFunction']
  readonly replaceProperty: JestObject['replaceProperty']
  setTimeout(timeout: number): J
  retryTimes(numRetries: number, options?: JestRetryOptions): J
  getSeed(): number
  isEnvironmentTornDown(): boolean
  mocked<T>(item: T): T
  clearAllMocks(): J
  resetAllMocks(): J
  restoreAllMocks(): J
}

/** The names of `jest`'s timer members that `createTimerMembers` builds (Vitest-only ones left out). */
const TIMER_MEMBER_NAMES = [
  'useFakeTimers',
  'useRealTimers',
  'runAllTimers',
  'runAllTimersAsync',
  'runOnlyPendingTimers',
  'runOnlyPendingTimersAsync',
  'advanceTimersByTime',
  'advanceTimersByTimeAsync',
  'advanceTimersToNextTimer',
  'advanceTimersToNextTimerAsync',
  'advanceTimersToNextFrame',
  'runAllTicks',
  'clearAllTimers',
  'getTimerCount',
  'now',
  'setSystemTime',
  'getRealSystemTime',
  'setTimerTickMode',
] as const satisfies readonly (keyof TimerMembers)[]

/** `jest`'s timer members over the clock of the file running now. */
function timerMembers<J>(host: JestGlobalsHost, self: () => J): JestTimerMembers<J> {
  const all = createTimerMembers(() => host.timers(), host.timersPolicy, self)
  const members: Record<string, unknown> = {}
  for (const name of TIMER_MEMBER_NAMES) members[name] = all[name]
  // jest-runtime 30.5.2 `JestGlobals.ts` `runAllImmediates`: the modern timers answer with this.
  Object.assign(members, {
    runAllImmediates: (): never => {
      throw new TypeError(
        '`jest.runAllImmediates()` is only available when using legacy fake timers.',
      )
    },
  })
  // The members are loosely typed (`TimerMembers`); the interface above is their contract.
  return members as unknown as JestTimerMembers<J>
}

/** The shared members. `self` is the object a chained call returns: the global, or the module's. */
function sharedMembers<J>(
  host: JestGlobalsHost,
  isolating: Isolating,
  self: () => J,
): SharedMembers<J> {
  return {
    ...timerMembers(host, self),
    isolateModules(fn) {
      const registry = host.registry()
      enterIsolation(isolating, registry, 'isolateModules')
      try {
        registry.isolateModules(fn)
      } finally {
        isolating.delete(registry)
      }
      // jest-runtime 30.5.2 `JestGlobals.ts` L267-L270 returns `jestObject` (recorded: `policy/jest-object-returns`)
      return self()
    },
    async isolateModulesAsync(fn) {
      const registry = host.registry()
      enterIsolation(isolating, registry, 'isolateModulesAsync')
      try {
        // jest-runtime 30.5.2 `JestGlobals.ts` L271 hands back the runtime's `Promise<void>` (recorded: `policy/jest-object-returns`)
        await registry.isolateModulesAsync(fn)
      } finally {
        isolating.delete(registry)
      }
    },
    resetModules() {
      host.registry().resetModules()
      // jest-runtime 30.5.2 `JestGlobals.ts` L263-L266 returns `jestObject` (recorded: `policy/jest-object-returns`)
      return self()
    },
    fn<T extends MockTarget = UnknownFunction>(impl?: T): Mock<T> {
      return createMockFn<T>(
        host.mockPolicy,
        host.mocks(),
        // Jest treats every falsy value as no implementation (jest-mock `index.ts` L1233-L1241).
        impl ? { impl } : undefined,
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
    setTimeout(timeout) {
      host.setDefaultTimeout(timeout)
      return self()
    },
    retryTimes() {
      // jest-circus retries a failed test after the file's other tests; the core runs retries at
      // once only (`retry.timing: 'deferred'` is T5.10), so a call that would run them in another
      // order is refused by name instead.
      throw new Error(
        "jest.retryTimes is not supported yet: Jest retries a failed test after the file's other tests, which Provino does not run (T5.10)",
      )
    },
    getSeed: () => host.seed,
    isEnvironmentTornDown: () => host.environmentTornDown(),
    mocked: <T>(item: T): T => item,
    clearAllMocks() {
      host.mocks().clearAll()
      return self()
    },
    resetAllMocks() {
      host.mocks().resetAll()
      return self()
    },
    restoreAllMocks() {
      host.mocks().restoreAll()
      return self()
    },
  }
}

/** What `jest.mock(name, factory)` registers: the factory, or an automock (a manual mock first). */
function specFor(factory: unknown): MockSpec {
  return typeof factory === 'function'
    ? { kind: 'factory', factory: factory as MockFactory }
    : { kind: 'automock', spy: false }
}

/**
 * The `jest` of the module at `from`. Registrations go through the file registry
 * (`registerMock`), so the loader knows what is mocked; `requireMock`, `createMockFromModule` and
 * automock-all act on the file's module-mock registry. Each reads `host` when it is called.
 */
function moduleJest(host: JestGlobalsHost, isolating: Isolating, from: string): JestModuleObject {
  const parent = from as ModuleId
  const register = (
    name: string,
    factory: unknown,
    options: JestMockOptions | undefined,
    hoisted: boolean,
  ): JestModuleObject => {
    host.registry().registerMock(name, parent, specFor(factory), {
      ...(options?.virtual === true ? { virtual: true } : {}),
      hoisted,
    })
    return jest
  }
  const unregister = (name: string): JestModuleObject => {
    host.registry().unregisterMock(name, parent)
    return jest
  }
  const setAutomock = (on: boolean): JestModuleObject => {
    host.moduleMocks().setAutomock(on)
    return jest
  }
  // Jest's own object lists its keys alphabetically (recorded: `mocking/api-surface`), so this one does too.
  const jest: JestModuleObject = withSortedKeys({
    ...sharedMembers<JestModuleObject>(host, isolating, () => jest),
    mock: (name, factory, options) => register(name, factory, options, true),
    doMock: (name, factory, options) => register(name, factory, options, false),
    unmock: unregister,
    // Jest's non-hoisted unmock is `dontMock`; there is no `doUnmock` (mod-unmock, B13b).
    dontMock: unregister,
    setMock: (name, moduleExports) => register(name, () => moduleExports, undefined, false),
    deepUnmock(name) {
      // jest-runtime `deepUnmock`: unmocked, and so is everything it imports under automock-all.
      host.registry().registerMock(name, parent, { kind: 'unmock', deep: true }, { hoisted: true })
      return jest
    },
    autoMockOn: () => setAutomock(true),
    autoMockOff: () => setAutomock(false),
    onGenerateMock<T>(callback: (moduleName: string, moduleMock: T) => T) {
      host
        .moduleMocks()
        .onGenerateMock(callback as (moduleId: string, moduleMock: unknown) => unknown)
      return jest
    },
    unstable_mockModule: (name, factory, options) => {
      // jest-runtime `unstable_mockModule`: the factory is required.
      if (typeof factory !== 'function') {
        throw new TypeError('`unstable_mockModule` must be passed a mock factory')
      }
      return register(name, factory, options, false)
    },
    unstable_unmockModule: unregister,
    requireActual: <T>(name: string): T => host.registry().requireActual<T>(name, parent),
    requireMock: <T>(name: string): T => host.moduleMocks().mockFor(name, from) as T,
    createMockFromModule: <T>(name: string): T =>
      host.moduleMocks().createMockFromModule(name, from) as T,
    enableAutomock: () => setAutomock(true),
    disableAutomock: () => setAutomock(false),
  })
  return jest
}

/** `value` with its own keys in code-unit order, as Jest's `jest` object lists them. */
function withSortedKeys<T extends object>(value: T): T {
  const keys = Object.keys(value).sort()
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)])) as T
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
 * Nothing else: the module-mock calls are on each module's own `jest` (`jestModuleScope`), which
 * knows its caller.
 * @public
 */
export function jestGlobals(host: JestGlobalsHost): JestGlobals {
  const known = globalsByHost.get(host)
  if (known !== undefined) return known
  const built = buildGlobals(host)
  globalsByHost.set(host, built)
  return built
}

/**
 * One set per host: the worker's injected globals and `@jest/globals` (which `jestModuleScope`
 * serves, with `injectGlobals: false` too) are the same objects, as in jest-runtime.
 */
const globalsByHost = new WeakMap<JestGlobalsHost, JestGlobals>()

function buildGlobals(host: JestGlobalsHost): JestGlobals {
  const { api, expect } = host
  // The registries with an isolation running now. Jest keeps this on each file's module registries
  // (one set per file's runtime); a `FileRegistry` is the same scope here, so a `WeakSet` keyed by
  // it is the same record without a module-level one: every `jestGlobals` call (one per worker)
  // has its own, a file's registry can be collected with it, and one that never finishes (a hung
  // test) blocks only itself.
  const isolating: Isolating = new WeakSet()
  const jest: JestObject = sharedMembers<JestObject>(host, isolating, () => jest)
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

/** What `require('expect')` is: `expect`'s own exports (`expect`, `default`). */
function expectModule(expect: JestGlobals['expect']): Readonly<Record<string, unknown>> {
  return { __esModule: true, expect, default: expect }
}

/**
 * The Jest dialect's per-module bindings (`jestDialect.moduleScope`, a `ModuleScopeFactory`): the
 * loader calls the function this returns for each module whose source names `jest`, and that
 * module's wrapper gets its own `jest`, as jest-runtime's `_createJestObjectFor(from)` gives each
 * module one. Called once per worker; the objects read `host` when they are called, so a module
 * shared under isolation `none` acts on the file running now.
 * @public
 */
export function jestModuleScope(
  host: JestGlobalsHost,
): (from: string) => Readonly<Record<string, unknown>> {
  // One record of isolating registries for every module's `jest`, apart from the global's: the
  // file's module-mock registry refuses a nested isolation between the two (`nested-isolation`).
  const isolating: Isolating = new WeakSet()
  // jest-runtime keeps one `jest` object per module (`jestObjectCaches`): the `jest` a module's
  // wrapper binds and the one `@jest/globals` hands it are the same object.
  const objects = new Map<string, JestModuleObject>()
  return (from) => {
    let jest = objects.get(from)
    if (jest === undefined) {
      jest = moduleJest(host, isolating, from)
      objects.set(from, jest)
    }
    // Lazy and not enumerable: a module that names none builds nothing, and the keys of the
    // result stay the binding names (`jestDialect.moduleScope.names`).
    const scope: Record<string, unknown> = { jest }
    const served = (name: string, get: () => unknown): void => {
      Object.defineProperty(scope, name, { get, enumerable: false })
    }
    // jest-runtime `cjsGlobals(from)`: the injected globals, with this module's own `jest`.
    served('@jest/globals', () => ({ ...jestGlobals(host), jest }))
    // U9: `expect` and `@jest/expect` are the runner's own, never a second copy from the project.
    served('expect', () => expectModule(jestGlobals(host).expect))
    served('@jest/expect', () => ({ jestExpect: jestGlobals(host).expect }))
    served('jest-mock', () => ({
      fn: jest.fn,
      spyOn: jest.spyOn,
      replaceProperty: jest.replaceProperty,
    }))
    return scope
  }
}
