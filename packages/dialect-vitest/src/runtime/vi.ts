// The Vitest dialect's `vi` (T11.16's facade, B25f): Vitest 5.0.5's `createVitest()`
// (`packages/vitest/src/integrations/vi.ts`) over the worker's engines. The mock functions are
// `@provino/mock`'s over the file's registry, the timers `@provino/timers`' over the file's clock,
// the module mocks the loader's, all read from the host when a member is called (each file has
// its own). Vitest has one `vi` and finds a `vi.mock` caller from the stack (`getImporter`);
// here each module that names `vi` gets its own object (`vitestModuleScope`), which knows its
// module, and every object of one host shares the stubs and `setConfig`'s saved values, as
// Vitest's one object does. Its keys come in Vitest's order (`mocking/api-surface`).
import type { RuntimeApi } from '@provino/core'
import type { createExpect } from '@provino/expect'
import {
  automock,
  createMockFn,
  createStubs,
  isMockFunction,
  type Mock,
  type MockRegistry,
  type MockTarget,
  type SpiedGetter,
  type SpiedMethod,
  type SpiedSetter,
  type SpyableKeys,
  type Stubs,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import { createTimerMembers, type FakeClock, type FakeTimersConfig } from '@provino/timers'
import type {
  GlobalsHost,
  MockFactory,
  MockSpec,
  ModuleId,
  ModulePolicy,
  TimersPolicy,
} from '@provino/types'
import { vitestModulePolicy } from '../mock-policy.ts'
import { assertTypes } from '../vendor/vitest-utils/helpers.ts'
import { createWait } from './vendor/vitest-vi/wait.ts'
import { isWhenChain, when } from './vendor/vitest-vi/when.ts'

/**
 * What `vitestGlobals` and `vitestModuleScope` build from: `GlobalsHost` with the real types of
 * the objects it declares as `object` (the worker's `RuntimeGlobalsHost` is one).
 * @public
 */
export interface VitestGlobalsHost extends GlobalsHost {
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
 * What `vi.useFakeTimers` takes: Vitest's `fakeTimers` options.
 * @public
 */
export type VitestFakeTimersConfig = Pick<
  FakeTimersConfig,
  | 'now'
  | 'toFake'
  | 'toNotFake'
  | 'shouldAdvanceTime'
  | 'advanceTimeDelta'
  | 'loopLimit'
  | 'shouldClearNativeTimers'
>

/**
 * What `vi.mock` takes in place of a factory: `{ spy: true }` spies on the real module's exports.
 * @public
 */
export interface VitestMockOptions {
  readonly spy?: boolean
}

/**
 * What `vi.waitFor` and `vi.waitUntil` take: the timeout, or the timeout and the interval (ms).
 * @public
 */
export type VitestWaitOptions = number | { readonly interval?: number; readonly timeout?: number }

/**
 * What `vi.setConfig` applies: the default timeout of tests and hooks, and the fake-timer
 * defaults of `vi.useFakeTimers()`. Another key is warned about and left.
 * @public
 */
export interface VitestRuntimeOptions {
  readonly testTimeout?: number
  readonly fakeTimers?: VitestFakeTimersConfig
  readonly [key: string]: unknown
}

/**
 * What `vi.when(spy)` returns: behaviours by the arguments the mock is called with, matched by
 * deep equality, the last registered first.
 * @public
 */
export interface VitestWhen {
  calledWith(...args: readonly unknown[]): VitestWhenCalledWith
}

/**
 * The behaviours of one set of arguments (`vi.when(spy).calledWith(...)`).
 * @public
 */
export interface VitestWhenCalledWith extends VitestWhen {
  thenReturn(value: unknown, options?: { readonly times?: number }): VitestWhenCalledWith
  thenReturnOnce(value: unknown): VitestWhenCalledWith
  thenResolve(value: unknown, options?: { readonly times?: number }): VitestWhenCalledWith
  thenResolveOnce(value: unknown): VitestWhenCalledWith
  thenThrow(value: unknown, options?: { readonly times?: number }): VitestWhenCalledWith
  thenThrowOnce(value: unknown): VitestWhenCalledWith
  thenReject(value: unknown, options?: { readonly times?: number }): VitestWhenCalledWith
  thenRejectOnce(value: unknown): VitestWhenCalledWith
}

/**
 * Vitest 5.0.5's `vi`. Every member that changes something returns this object.
 * @public
 */
export interface VitestObject {
  useFakeTimers(config?: VitestFakeTimersConfig): VitestObject
  isFakeTimers(): boolean
  useRealTimers(): VitestObject
  runOnlyPendingTimers(): VitestObject
  runOnlyPendingTimersAsync(): Promise<VitestObject>
  runAllTimers(): VitestObject
  runAllTimersAsync(): Promise<VitestObject>
  runAllTicks(): VitestObject
  advanceTimersByTime(ms: number): VitestObject
  advanceTimersByTimeAsync(ms: number): Promise<VitestObject>
  advanceTimersToNextTimer(): VitestObject
  advanceTimersToNextTimerAsync(): Promise<VitestObject>
  advanceTimersToNextFrame(): VitestObject
  getTimerCount(): number
  setSystemTime(time: number | string | Date): VitestObject
  getMockedSystemTime(): Date | null
  getRealSystemTime(): number
  clearAllTimers(): VitestObject
  setTimerTickMode(mode: 'manual' | 'nextTimerAsync' | 'interval', interval?: number): VitestObject
  /** Replaces a method with a spy that calls through. */
  spyOn<T extends object, K extends SpyableKeys<T>>(object: T, key: K): SpiedMethod<Required<T>[K]>
  /** Replaces an accessor's getter with a spy that calls through. */
  spyOn<T extends object, K extends keyof T>(object: T, key: K, access: 'get'): SpiedGetter<T[K]>
  /** Replaces an accessor's setter with a spy that calls through. */
  spyOn<T extends object, K extends keyof T>(object: T, key: K, access: 'set'): SpiedSetter<T[K]>
  /** A mock function, running `impl` when it has one. */
  fn<T extends MockTarget = UnknownFunction>(impl?: T): Mock<T>
  /** Behaviours of a mock by the arguments it is called with (Vitest's `vi.when`). */
  when(spy: Mock<UnknownFunction>, options?: { readonly onUnmatched?: unknown }): VitestWhen
  /** Whether `value` is a chain `vi.when` made. */
  isWhenChain(value: object): boolean
  /** Calls `callback` every `interval` ms until it doesn't throw, or rejects after `timeout`. */
  waitFor<T>(callback: () => T | Promise<T>, options?: VitestWaitOptions): Promise<T>
  /** Calls `callback` every `interval` ms until it returns a truthy value. */
  waitUntil<T>(callback: () => T | Promise<T>, options?: VitestWaitOptions): Promise<T>
  /** Wraps `fn` so a failure's stack starts at its caller. */
  defineHelper<F extends (...args: never[]) => unknown>(fn: F): F
  /** Runs `factory` now (the hoister moves the call above the imports). */
  hoisted<T>(factory: () => T): T
  /** Mocks `path` for this file, hoisted: by `factory`, a manual mock, or an automock. */
  mock(path: string, factory?: MockFactory | VitestMockOptions): void
  /** The real module from now on (hoisted). */
  unmock(path: string): void
  /** `mock`, not hoisted. */
  doMock(path: string, factory?: MockFactory | VitestMockOptions): object
  /** `unmock`, not hoisted. */
  doUnmock(path: string): void
  /** The real module, whatever is mocked. */
  importActual<T = unknown>(path: string): Promise<T>
  /** The mocked module: a manual mock, else an automock. */
  importMock<T = unknown>(path: string): Promise<T>
  /** An automock (or, with `{ spy: true }`, an autospy) of `value`. */
  mockObject<T>(value: T, options?: VitestMockOptions): T
  /** The argument, typed as mocked (the identity). */
  mocked<T>(item: T, options?: object): T
  /** Whether `value` is a mock function. */
  isMockFunction(value: unknown): value is Mock<UnknownFunction>
  clearAllMocks(): VitestObject
  resetAllMocks(): VitestObject
  restoreAllMocks(): VitestObject
  /** Defines `name` on the global as `value` until `unstubAllGlobals()`. */
  stubGlobal(name: string | symbol | number, value: unknown): VitestObject
  /** Sets `process.env[name]` (`undefined` deletes it) until `unstubAllEnvs()`. */
  stubEnv(name: string, value: string | boolean | undefined): VitestObject
  unstubAllGlobals(): VitestObject
  unstubAllEnvs(): VitestObject
  /** Forgets every module loaded so far in the file. */
  resetModules(): VitestObject
  /** Resolves when the dynamic imports started so far have settled. */
  dynamicImportSettled(): Promise<void>
  setConfig(config: VitestRuntimeOptions): void
  resetConfig(): void
}

/** What every `vi` of one host shares, as Vitest's one object keeps it. */
export interface ViShared {
  readonly host: VitestGlobalsHost
  /** The stubs of each file's mock registry: its `dispose` and between-test steps reach them. */
  readonly stubs: WeakMap<MockRegistry, Stubs>
  /** `setConfig`'s values. */
  config: VitestRuntimeOptions | undefined
}

/** Makes the state one host's `vi` objects share. @internal */
export function createViShared(host: VitestGlobalsHost): ViShared {
  return { host, stubs: new WeakMap(), config: undefined }
}

/**
 * The real timers, taken as this module loads: before a test can fake them, as Vitest's
 * `getSafeTimers()` keeps them. `waitFor` and `dynamicImportSettled` wait on them.
 */
const SAFE_TIMERS = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
}

/** `vi.stubEnv`'s names that hold a boolean (`_envBooleans`, vi.ts L629). */
const ENV_BOOLEANS: readonly string[] = ['PROD', 'DEV', 'SSR']

/** The keys `vi.setConfig` applies. */
const APPLIED_CONFIG_KEYS: ReadonlySet<string> = new Set(['testTimeout', 'fakeTimers'])

/** The keys `vi.setConfig` has warned about, once each per process. */
const warnedConfigKeys = new Set<string>()

/** What `vi.mock(path, factoryOrOptions)` registers (Vitest's `queueMock`). */
function specFor(factory: unknown): MockSpec {
  if (typeof factory === 'function') return { kind: 'factory', factory: factory as MockFactory }
  const spy =
    factory !== null && typeof factory === 'object' && Reflect.get(factory, 'spy') === true
  return { kind: 'automock', spy }
}

/** vi.ts L696-L698 and its three twins: the path must be a string. */
function assertPath(path: unknown, member: string): asserts path is string {
  if (typeof path !== 'string') {
    throw new TypeError(`vi.${member}() expects a string path, but received a ${typeof path}`)
  }
}

/** The file's stubs, made on first use over its mock registry. */
function stubsOf(shared: ViShared): Stubs {
  const registry = shared.host.mocks()
  let stubs = shared.stubs.get(registry)
  if (stubs === undefined) {
    stubs = createStubs(registry, process.env, globalThis)
    shared.stubs.set(registry, stubs)
  }
  return stubs
}

/** vi.ts L620-L640 (`defineHelper`): a rejection's stack is the helper caller's. */
function defineHelper<F extends (...args: never[]) => unknown>(fn: F): F {
  return function __VITEST_HELPER__(this: unknown, ...args: never[]): unknown {
    const result = fn.apply(this, args)
    if (
      result !== null &&
      typeof result === 'object' &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      const stackTraceError = new Error('STACK_TRACE_ERROR')
      return (async function __VITEST_HELPER__(): Promise<unknown> {
        try {
          return await result
        } catch (error) {
          if (error instanceof Error && !error.stack?.includes('__VITEST_HELPER__')) {
            if (stackTraceError.stack !== undefined) {
              error.stack = stackTraceError.stack.replace(stackTraceError.message, error.message)
            }
          }
          throw error
        }
      })()
    }
    return result
  } as F
}

/**
 * Builds a `vi` over `shared`'s host. `from` is the module whose own object it is: `vi.mock` and
 * the imports resolve from it (`null` for the injected global, which resolves from the root).
 * @internal
 */
export function createVi(shared: ViShared, from: string | null): VitestObject {
  const { host } = shared
  const parent = from as ModuleId | null
  const self = (): VitestObject => vi
  const timers = createTimerMembers(() => host.timers(), host.timersPolicy, self)
  const timer = timers as unknown as Record<string, (...args: readonly unknown[]) => unknown>
  const chain =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A): VitestObject => {
      run(...args)
      return vi
    }
  const register = (path: string, factory: unknown, hoisted: boolean): void => {
    host.registry().registerMock(path, parent, specFor(factory), { hoisted })
  }
  const { waitFor, waitUntil } = createWait(
    {
      isFakeTimers: () => vi.isFakeTimers(),
      advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
    },
    SAFE_TIMERS,
  )
  const vi: VitestObject = {
    useFakeTimers(config) {
      const defaults = shared.config?.fakeTimers
      timer.useFakeTimers?.(defaults === undefined ? config : { ...defaults, ...config })
      return vi
    },
    isFakeTimers: () => timer.isFakeTimers?.() as boolean,
    useRealTimers: timers.useRealTimers as VitestObject['useRealTimers'],
    runOnlyPendingTimers: timers.runOnlyPendingTimers as VitestObject['runOnlyPendingTimers'],
    runOnlyPendingTimersAsync:
      timers.runOnlyPendingTimersAsync as VitestObject['runOnlyPendingTimersAsync'],
    runAllTimers: timers.runAllTimers as VitestObject['runAllTimers'],
    runAllTimersAsync: timers.runAllTimersAsync as VitestObject['runAllTimersAsync'],
    runAllTicks: timers.runAllTicks as VitestObject['runAllTicks'],
    advanceTimersByTime: timers.advanceTimersByTime as VitestObject['advanceTimersByTime'],
    advanceTimersByTimeAsync:
      timers.advanceTimersByTimeAsync as VitestObject['advanceTimersByTimeAsync'],
    advanceTimersToNextTimer:
      timers.advanceTimersToNextTimer as VitestObject['advanceTimersToNextTimer'],
    advanceTimersToNextTimerAsync:
      timers.advanceTimersToNextTimerAsync as VitestObject['advanceTimersToNextTimerAsync'],
    advanceTimersToNextFrame:
      timers.advanceTimersToNextFrame as VitestObject['advanceTimersToNextFrame'],
    getTimerCount: timers.getTimerCount as VitestObject['getTimerCount'],
    setSystemTime: timers.setSystemTime as VitestObject['setSystemTime'],
    getMockedSystemTime: timers.getMockedSystemTime as VitestObject['getMockedSystemTime'],
    getRealSystemTime: timers.getRealSystemTime as VitestObject['getRealSystemTime'],
    clearAllTimers: timers.clearAllTimers as VitestObject['clearAllTimers'],
    setTimerTickMode: timers.setTimerTickMode as VitestObject['setTimerTickMode'],
    // The engine's overloads take the access kind last; one signature serves all three.
    spyOn: ((object: object, key: PropertyKey, access?: 'get' | 'set'): unknown =>
      (spyOn as (...args: readonly unknown[]) => unknown)(
        host.mockPolicy,
        host.mocks(),
        object,
        key,
        access,
      )) as VitestObject['spyOn'],
    fn<T extends MockTarget = UnknownFunction>(impl?: T): Mock<T> {
      return createMockFn<T>(
        host.mockPolicy,
        host.mocks(),
        impl === undefined ? undefined : { impl },
      )
    },
    when: when as unknown as VitestObject['when'],
    isWhenChain: isWhenChain as VitestObject['isWhenChain'],
    waitFor: waitFor as VitestObject['waitFor'],
    waitUntil: waitUntil as unknown as VitestObject['waitUntil'],
    defineHelper,
    hoisted<T>(factory: () => T): T {
      assertTypes(factory, '"vi.hoisted" factory', ['function'])
      return factory()
    },
    mock(path, factory) {
      assertPath(path, 'mock')
      register(path, factory, true)
    },
    unmock(path) {
      assertPath(path, 'unmock')
      host.registry().unregisterMock(path, parent)
    },
    doMock(path, factory) {
      assertPath(path, 'doMock')
      register(path, factory, false)
      // vi.ts L688-L694: a disposable that unmocks again.
      return { [Symbol.dispose]: () => host.registry().unregisterMock(path, parent) }
    },
    doUnmock(path) {
      assertPath(path, 'doUnmock')
      host.registry().unregisterMock(path, parent)
    },
    importActual: <T>(path: string): Promise<T> => host.registry().importActual<T>(path, parent),
    importMock: <T>(path: string): Promise<T> =>
      new Promise<T>((done) => done(host.moduleMocks().mockFor(path, from ?? '') as T)),
    mockObject<T>(value: T, options?: VitestMockOptions): T {
      const shape: ModulePolicy['automockShape'] = vitestModulePolicy.automockShape
      const made = automock({ value }, shape, options?.spy ? 'autospy' : 'automock', (made) =>
        createMockFn(host.mockPolicy, host.mocks(), made),
      ) as { value: T }
      return made.value
    },
    mocked: <T>(item: T): T => item,
    isMockFunction(value: unknown): value is Mock<UnknownFunction> {
      return isMockFunction(host.mockPolicy, value)
    },
    clearAllMocks: chain(() => host.mocks().clearAll()),
    resetAllMocks: chain(() => host.mocks().resetAll()),
    restoreAllMocks: chain(() => host.mocks().restoreAll()),
    stubGlobal: chain((name: string | symbol | number, value: unknown) => {
      stubsOf(shared).stubGlobal(name, value)
    }),
    stubEnv: chain((name: string, value: string | boolean | undefined) => {
      // vi.ts L737-L748: `undefined` deletes, PROD/DEV/SSR hold '1' or '', the rest a string.
      const text =
        value === undefined
          ? undefined
          : ENV_BOOLEANS.includes(name)
            ? value
              ? '1'
              : ''
            : String(value)
      stubsOf(shared).stubEnv(name, text)
    }),
    unstubAllGlobals: chain(() => {
      stubsOf(shared).unstubAllGlobals()
    }),
    unstubAllEnvs: chain(() => {
      stubsOf(shared).unstubAllEnvs()
    }),
    resetModules: chain(() => host.registry().resetModules()),
    async dynamicImportSettled() {
      // limit: Vitest waits a macrotask, then for every module still evaluating (vi.ts
      // `waitForImportsToResolve`); the loader keeps no such list, so this is the macrotask only.
      await new Promise<void>((done) => SAFE_TIMERS.setTimeout(done, 0))
    },
    setConfig(config) {
      shared.config = { ...shared.config, ...config }
      for (const key of Object.keys(config)) {
        if (APPLIED_CONFIG_KEYS.has(key) || warnedConfigKeys.has(key)) continue
        warnedConfigKeys.add(key)
        process.emitWarning(
          `vi.setConfig({ ${key} }) is not applied by Provino: only testTimeout and fakeTimers are`,
          { code: 'PROVINO_VITEST_SET_CONFIG' },
        )
      }
      if (config.testTimeout !== undefined) host.setDefaultTimeout(config.testTimeout)
    },
    resetConfig() {
      if (shared.config?.testTimeout !== undefined) host.setDefaultTimeout(undefined)
      shared.config = undefined
    },
  }
  return vi
}
