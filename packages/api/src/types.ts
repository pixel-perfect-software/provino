// The native API's types: what the served `provino` module and `globals: true` hold, typed by the
// engines they come from, and the host the worker builds them over.
import type { FixtureTestApi, RuntimeApi, SuiteApi } from '@provino/core'
import type { createExpect } from '@provino/expect'
import type {
  Mock,
  MockRegistry,
  MockTarget,
  Replaced,
  SpiedGetter,
  SpiedMethod,
  SpiedSetter,
  SpyableKeys,
  UnknownFunction,
} from '@provino/mock'
import type { FakeClock, FakeTimersConfig, SystemTime, TimerTickMode } from '@provino/timers'
import type { GlobalsHost } from '@provino/types'

/**
 * What `provinoModuleScope` and `provinoGlobals` build from: `GlobalsHost` with the real types of
 * the objects it declares as `object` (the worker's `RuntimeGlobalsHost` is one).
 * @public
 */
export interface ApiHost extends GlobalsHost {
  /** Core's global API: `runtime.api`. */
  readonly api: RuntimeApi
  /** The worker's `expect`, from `createExpect`. */
  readonly expect: ReturnType<typeof createExpect>
  /** The mock registry of the file running now (the worker's, under isolation `none`). */
  mocks(): MockRegistry
  /** The fake clock of the file running now, on the environment's global. */
  timers(): FakeClock
}

/**
 * `spyOn`: replaces a method, or an accessor's getter or setter, with a spy that calls through,
 * registered with the file running now so `mocks.restoreAll()` puts it back.
 * @public
 */
export interface ProvinoSpyOn {
  <T extends object, K extends SpyableKeys<T>>(object: T, key: K): SpiedMethod<Required<T>[K]>
  <T extends object, K extends keyof T>(object: T, key: K, access: 'get'): SpiedGetter<T[K]>
  <T extends object, K extends keyof T>(object: T, key: K, access: 'set'): SpiedSetter<T[K]>
}

/**
 * The mock registry of the file running now, as a test sees it.
 * @public
 */
export interface ProvinoMocks {
  /** Forgets every mock's calls and results; implementations stay. */
  clearAll(): void
  /** `clearAll`, and every mock's implementation goes too. */
  resetAll(): void
  /** Puts back every property `spyOn` and `replaceProperty` replaced. */
  restoreAll(): void
}

/**
 * The fake clock of the file running now (`@provino/timers`). Each member that changes the clock
 * returns this object (the neutral `facadeReturns: 'all'`); a question returns its answer.
 * @public
 */
export interface ProvinoTimers {
  useFakeTimers(config?: FakeTimersConfig): ProvinoTimers
  useRealTimers(): ProvinoTimers
  isFakeTimers(): boolean
  runAllTimers(): ProvinoTimers
  runAllTimersAsync(): Promise<ProvinoTimers>
  runOnlyPendingTimers(): ProvinoTimers
  runOnlyPendingTimersAsync(): Promise<ProvinoTimers>
  advanceTimersByTime(ms: number): ProvinoTimers
  advanceTimersByTimeAsync(ms: number): Promise<ProvinoTimers>
  advanceTimersToNextTimer(steps?: number): ProvinoTimers
  advanceTimersToNextTimerAsync(steps?: number): Promise<ProvinoTimers>
  advanceTimersToNextFrame(): ProvinoTimers
  runAllTicks(): ProvinoTimers
  clearAllTimers(): ProvinoTimers
  getTimerCount(): number
  setSystemTime(time?: SystemTime | string): ProvinoTimers
  getRealSystemTime(): number
  getMockedSystemTime(): Date | null
  setTimerTickMode(mode: TimerTickMode): ProvinoTimers
  now(): number
}

/**
 * A module mock's factory (`mock(specifier, factory)`): the module's exports as an object (`default`
 * for a default export), or a Promise of them. It is given `importOriginal`, which loads the real
 * module. An export the object lacks throws when it is read (the neutral `missingFactoryExport`).
 * @public
 */
export type ProvinoMockFactory<T extends object = Record<string, unknown>> = (
  importOriginal: () => Promise<T>,
) => Partial<T> | Promise<Partial<T>>

/**
 * `mock`: replaces the module `specifier` names (resolved from the module that calls it) with the
 * factory's exports, or with an automock of the real module when there is no factory. Imported from
 * `provino`, a top-level call is hoisted above the file's imports.
 * @public
 */
export type ProvinoMock = <T extends object = Record<string, unknown>>(
  specifier: string,
  factory?: ProvinoMockFactory<T>,
) => void

/**
 * Provino's native test API (D185): what `import { … } from 'provino'` binds in a project with no
 * dialect, built once per worker. The lazy variables are `provino`'s too, but read their own slot.
 * A type alias, not an interface, so it is a `GlobalsFactory`'s record.
 * @public
 */
export type ProvinoApi = {
  readonly describe: SuiteApi
  readonly suite: SuiteApi
  /** With `extend` and `override`: the neutral policy exposes fixtures (`extendApi: 'expose'`). */
  readonly it: FixtureTestApi
  readonly test: FixtureTestApi
  readonly beforeAll: RuntimeApi['beforeAll']
  readonly afterAll: RuntimeApi['afterAll']
  readonly beforeEach: RuntimeApi['beforeEach']
  readonly afterEach: RuntimeApi['afterEach']
  readonly aroundEach: RuntimeApi['aroundEach']
  readonly aroundAll: RuntimeApi['aroundAll']
  readonly onTestFinished: RuntimeApi['onTestFinished']
  readonly onTestFailed: RuntimeApi['onTestFailed']
  /** The worker's `expect`, with its matchers, `extend` and asymmetric matchers. */
  readonly expect: ReturnType<typeof createExpect>
  /** A mock function, running `impl` when it has one. */
  readonly fn: <T extends MockTarget = UnknownFunction>(impl?: T) => Mock<T>
  readonly spyOn: ProvinoSpyOn
  /** Replaces a plain value property until `restore` or `mocks.restoreAll()`. */
  readonly replaceProperty: <T extends object, K extends keyof T>(
    object: T,
    key: K,
    value: T[K],
  ) => Replaced<T[K]>
  readonly isMockFunction: (value: unknown) => value is Mock<UnknownFunction>
  readonly mocks: ProvinoMocks
  readonly timers: ProvinoTimers
  /** Mocks a module for the file running now (hoisted when imported from `provino`). */
  readonly mock: ProvinoMock
  /** Takes `specifier`'s module mock away again: it loads the real module (hoisted like `mock`). */
  readonly unmock: (specifier: string) => void
  /** The real module `specifier` names, past any mock of it (its own imports still decide). */
  readonly importActual: <T extends object = Record<string, unknown>>(
    specifier: string,
  ) => Promise<T>
}

/**
 * The names of `ProvinoApi` that act on module mocks. They resolve a specifier from the module
 * that imported them, so they are served per module and are never globals.
 * @public
 */
export type ProvinoModuleMockName = 'mock' | 'unmock' | 'importActual'

/**
 * What `globals: true` installs: `ProvinoApi` without the module-mock names (a global `mock` would
 * not be hoisted, so it would run after the imports it means to replace).
 * @public
 */
export type ProvinoGlobalsApi = Omit<ProvinoApi, ProvinoModuleMockName>
