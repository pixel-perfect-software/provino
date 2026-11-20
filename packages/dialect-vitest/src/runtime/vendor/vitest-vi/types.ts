// provino: stand-ins for the types `when.ts` and `wait.ts` import from `@vitest/spy`,
// `vitest/optional-runtime-types.js` and `@vitest/utils/timers`: only what the two files read.

export type Procedure = (...args: any[]) => any

export interface Mock<T extends Procedure = Procedure> {
  (...args: Parameters<T>): ReturnType<T>
  getMockImplementation(): T | undefined
  mockImplementation(fn: T): this
}

export interface Disposable {
  [Symbol.dispose](): void
}

/** The real timers (`getSafeTimers()`), taken before a test can fake them. */
export interface SafeTimers {
  setTimeout: typeof globalThis.setTimeout
  setInterval: typeof globalThis.setInterval
  clearTimeout: typeof globalThis.clearTimeout
  clearInterval: typeof globalThis.clearInterval
}

/** What `waitFor` and `waitUntil` read of `vi`. */
export interface WaitVi {
  isFakeTimers(): boolean
  advanceTimersByTime(ms: number): unknown
}

/** `@vitest/spy`'s own (`packages/spy/src/index.ts` L17-L19), typed over the stand-in `Mock`. */
export function isMockFunction(fn: any): fn is Mock {
  return typeof fn === 'function' && '_isMockFunction' in fn && fn._isMockFunction === true
}
