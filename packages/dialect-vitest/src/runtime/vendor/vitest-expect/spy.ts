// provino: a stand-in for `@vitest/spy`. `isMockFunction` is upstream's own
// (`packages/spy/src/index.ts` L17-L19), so a `@provino/mock` function, which has
// `_isMockFunction`, is one; the types name only what the matchers read.

export interface MockResult<T> {
  type: 'return' | 'throw' | 'incomplete'
  value: T
}

export interface MockSettledResult<T> {
  type: 'fulfilled' | 'rejected' | 'incomplete'
  value: T
}

export interface MockInstance {
  getMockName(): string
  mock: {
    calls: any[][]
    results: MockResult<any>[]
    settledResults: MockSettledResult<any>[]
    invocationCallOrder: number[]
    lastCall?: any[]
  }
}

export type Mock = MockInstance & ((...args: any[]) => any)

export function isMockFunction(fn: any): fn is Mock {
  return typeof fn === 'function' && '_isMockFunction' in fn && fn._isMockFunction === true
}
