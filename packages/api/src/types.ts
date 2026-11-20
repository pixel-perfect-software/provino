// The native API's types: what the served `provino` module and `globals: true` hold, typed by the
// engines they come from, and the host the worker builds them over.
import type { RuntimeApi, SuiteApi, TestApi } from '@provino/core'
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
 * Provino's native test API (D185): what `import { … } from 'provino'` binds in a project with no
 * dialect, built once per worker. The lazy variables are `provino`'s too, but read their own slot.
 * A type alias, not an interface, so it is a `GlobalsFactory`'s record.
 * @public
 */
export type ProvinoApi = {
  readonly describe: SuiteApi
  readonly suite: SuiteApi
  readonly it: TestApi
  readonly test: TestApi
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
}
