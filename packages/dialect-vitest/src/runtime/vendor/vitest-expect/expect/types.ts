// provino: a stand-in for upstream's `types.ts` (924 lines of public types over `@types/chai`, which
// this package does not depend on). Only the names the vendored files import are here; the ones
// that name Chai's objects are loose, the rest are upstream's own shapes.

export type ChaiPlugin = (chai: any, utils: any) => void

/** The names the vendored files define or delegate to, so `keyof Assertion` is that union. */
export type AssertionName =
  | 'callCount'
  | 'called'
  | 'calledAfter'
  | 'calledBefore'
  | 'calledOnce'
  | 'calledOnceWith'
  | 'calledThrice'
  | 'calledTwice'
  | 'calledWith'
  | 'lastCalledWith'
  | 'lastReturnedWith'
  | 'nthCalledWith'
  | 'nthReturnedWith'
  | 'returned'
  | 'returnedTimes'
  | 'returnedWith'
  | 'toBe'
  | 'toBeCalled'
  | 'toBeCalledTimes'
  | 'toBeCalledWith'
  | 'toBeCloseTo'
  | 'toBeDefined'
  | 'toBeFalsy'
  | 'toBeGreaterThan'
  | 'toBeGreaterThanOrEqual'
  | 'toBeInstanceOf'
  | 'toBeLessThan'
  | 'toBeLessThanOrEqual'
  | 'toBeNaN'
  | 'toBeNull'
  | 'toBeNullable'
  | 'toBeTruthy'
  | 'toBeTypeOf'
  | 'toBeUndefined'
  | 'toContain'
  | 'toContainEqual'
  | 'toEqual'
  | 'toHaveBeenCalled'
  | 'toHaveBeenCalledAfter'
  | 'toHaveBeenCalledBefore'
  | 'toHaveBeenCalledExactlyOnceWith'
  | 'toHaveBeenCalledOnce'
  | 'toHaveBeenCalledTimes'
  | 'toHaveBeenCalledWith'
  | 'toHaveBeenLastCalledWith'
  | 'toHaveBeenNthCalledWith'
  | 'toHaveLastResolvedWith'
  | 'toHaveLastReturnedWith'
  | 'toHaveLength'
  | 'toHaveNthResolvedWith'
  | 'toHaveNthReturnedWith'
  | 'toHaveProperty'
  | 'toHaveResolved'
  | 'toHaveResolvedTimes'
  | 'toHaveResolvedWith'
  | 'toHaveReturned'
  | 'toHaveReturnedTimes'
  | 'toHaveReturnedWith'
  | 'toMatch'
  | 'toMatchObject'
  | 'toReturn'
  | 'toReturnTimes'
  | 'toReturnWith'
  | 'toStrictEqual'
  | 'toThrow'
  | 'toThrowError'

export type Assertion<T = any> = Record<AssertionName, any>

export type ExpectStatic = any

export interface TesterContext {
  equals: (a: unknown, b: unknown, customTesters?: Array<Tester>, strictCheck?: boolean) => boolean
}

export type Tester = (
  this: TesterContext,
  a: any,
  b: any,
  customTesters: Array<Tester>,
) => boolean | undefined

export interface MatcherHintOptions {
  comment?: string
  expectedColor?: (arg: string) => string
  isDirectExpectCall?: boolean
  isNot?: boolean
  promise?: string
  receivedColor?: (arg: string) => string
  secondArgument?: string
  secondArgumentColor?: (arg: string) => string
}

export interface MatcherState {
  [key: string]: any
}

export interface SyncExpectationResult {
  pass: boolean
  message: () => string
  actual?: any
  expected?: any
}

export type MatchersObject = Record<string, (this: any, actual: any, ...expected: any[]) => any>
