// The first-cut public types (B13a Gap 10): `fn` and `spyOn` inference and misuse. T4.5 ports
// upstream's assertions and adds `JestMock`, `Mocked*` and the second view.

/**
 * A function of unknown shape, the default target of a mock.
 * @public
 */
export type UnknownFunction = (...args: unknown[]) => unknown

/**
 * Any function. Parameters are `never[]` so that every function type is assignable to it.
 * @public
 */
export type FunctionLike = (...args: never[]) => unknown

/**
 * Any class.
 * @public
 */
export type ClassLike = abstract new (...args: never[]) => unknown

/**
 * What a mock can stand in for.
 * @public
 */
export type MockTarget = FunctionLike | ClassLike

/**
 * The arguments of a target's call or construction.
 * @public
 */
export type MockParameters<T extends MockTarget> = T extends (...args: infer P) => unknown
  ? P
  : T extends abstract new (
        ...args: infer P
      ) => unknown
    ? P
    : never

/**
 * What a target's call returns, or the instance its construction makes.
 * @public
 */
export type MockReturn<T extends MockTarget> = T extends (...args: never[]) => infer R
  ? R
  : T extends abstract new (
        ...args: never[]
      ) => infer R
    ? R
    : never

/**
 * One entry of `mock.results`. `incomplete` is a call still running.
 * @public
 */
export type MockResult<R> =
  | { type: 'return'; value: R }
  | { type: 'throw'; value: unknown }
  | { type: 'incomplete'; value: undefined }

/**
 * One entry of `mock.settledResults`, on the policies that have it.
 * @public
 */
export type MockSettledResult<R> =
  | { type: 'fulfilled'; value: Awaited<R> }
  | { type: 'rejected'; value: unknown }
  | { type: 'incomplete'; value: undefined }

/**
 * What `fn.mock` holds. `lastCall` and `settledResults` exist per policy.
 * @public
 */
export interface MockState<T extends MockTarget = UnknownFunction> {
  calls: Array<MockParameters<T>>
  contexts: unknown[]
  instances: Array<MockReturn<T>>
  invocationCallOrder: number[]
  results: Array<MockResult<MockReturn<T>>>
  settledResults?: Array<MockSettledResult<MockReturn<T>>>
  lastCall?: MockParameters<T> | undefined
}

/**
 * The methods every mock has, under every policy (Track 4 L228): a policy changes defaults and
 * return values, never whether a method exists.
 * @public
 */
export interface MockInstance<T extends MockTarget = UnknownFunction> {
  readonly mock: MockState<T>
  readonly _isMockFunction: true
  getMockName(): string
  mockName(name: string): this
  getMockImplementation(): T | undefined
  mockClear(): this
  mockReset(): this
  mockRestore(): void
  mockImplementation(implementation: T): this
  mockImplementationOnce(implementation: T): this
  withImplementation(implementation: T, callback: () => Promise<unknown>): Promise<this | undefined>
  withImplementation(implementation: T, callback: () => unknown): this | undefined
  mockReturnThis(): this
  mockReturnValue(value: MockReturn<T>): this
  mockReturnValueOnce(value: MockReturn<T>): this
  mockResolvedValue(value: Awaited<MockReturn<T>>): this
  mockResolvedValueOnce(value: Awaited<MockReturn<T>>): this
  mockRejectedValue(value: unknown): this
  mockRejectedValueOnce(value: unknown): this
  mockThrow(value: unknown): this
  mockThrowOnce(value: unknown): this
  /** A sub-mock that answers the calls whose arguments equal these. */
  whenCalledWith(...args: unknown[]): Mock<T>
  [Symbol.dispose](): void
}

/**
 * A mock function: callable and constructable like its target, plus the mock methods.
 * @public
 */
export interface Mock<T extends MockTarget = UnknownFunction> extends MockInstance<T> {
  (...args: MockParameters<T>): MockReturn<T>
  new (...args: MockParameters<T>): MockReturn<T>
}

/**
 * What `createMockFn` builds a mock from. Every option is one a later builder needs: `impl` for
 * `fn(impl)`, `spy`, `original` and `restore` for spies, `name`, `length` and `fallback` for
 * automock and factories (B13b).
 * @public
 */
export interface CreateMockOptions<T extends MockTarget = UnknownFunction> {
  /** The implementation, as in `fn(impl)`. Under `resetTo: 'original-impl'`, `mockReset` returns to it. */
  readonly impl?: T | undefined
  /** The function's own `name`. Any string; a caller that needs an identifier sanitizes it first. */
  readonly name?: string | undefined
  /** The function's own `length`. Defaults to the implementation's. */
  readonly length?: number | undefined
  /**
   * What a call runs when the mock has no implementation, surviving `mockReset`. jest-mock's
   * `_protoImpl`: automocked instance methods fall through to their prototype's mock.
   */
  readonly fallback?: FunctionLike | undefined
  /** This mock is a spy: `spyNameFromMethod` and `spyReportsBridgeImpl` apply to it. */
  readonly spy?: boolean | undefined
  /** The spied function. A call runs it while the spy has no implementation of its own. */
  readonly original?: FunctionLike | undefined
  /** What `mockRestore` undoes after resetting. `restoreAll` needs its own restorer: `addRestorer`. */
  readonly restore?: (() => void) | undefined
}

/**
 * A property `replaceProperty` replaced.
 * @public
 */
export interface Replaced<V = unknown> {
  /** Sets another value; the original is still what `restore` puts back. */
  replaceValue(value: V): Replaced<V>
  restore(): void
}

/**
 * The environment and global stubs. Every method returns the same value, so calls chain.
 * @public
 */
export interface Stubs {
  /** Sets a variable, or deletes it for `undefined`. Anything else becomes a string. */
  stubEnv(name: string, value: string | undefined): Stubs
  /** Defines a global as a plain writable value. */
  stubGlobal(name: PropertyKey, value: unknown): Stubs
  /** Puts back every variable stubbed since the last call. */
  unstubAllEnvs(): Stubs
  /** Puts back every global stubbed since the last call. */
  unstubAllGlobals(): Stubs
}

/**
 * The keys of `T` whose values are functions or classes, which is what `spyOn` accepts without an
 * access type.
 * @public
 */
export type SpyableKeys<T> = {
  [K in keyof T]-?: Required<T>[K] extends MockTarget ? K : never
}[keyof T]

/**
 * What `spyOn(object, key)` returns.
 * @public
 */
export type SpiedMethod<V> = V extends MockTarget ? Mock<V> : never

/**
 * What `spyOn(object, key, 'get')` returns.
 * @public
 */
export type SpiedGetter<V> = Mock<() => V>

/**
 * What `spyOn(object, key, 'set')` returns.
 * @public
 */
export type SpiedSetter<V> = Mock<(value: V) => void>
