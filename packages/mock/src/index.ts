// @provino/mock: mock functions, spies, replaced properties and stubs, with a per-file registry.
// Neutral: every Jest/Vitest difference is a `MockPolicy` value the dialect supplies.
export { MockError, MockTypeError } from './errors.ts'
export { createMockFn, isMockFunction, MOCK_BRAND } from './mock-fn.ts'
export { createMockRegistry, type MockCleanupConfig, type MockRegistry } from './registry.ts'
export { replaceProperty, spyOn } from './spy.ts'
export { createStubs } from './stubs.ts'
export type {
  ClassLike,
  CreateMockOptions,
  FunctionLike,
  Mock,
  MockInstance,
  MockParameters,
  MockResult,
  MockReturn,
  MockSettledResult,
  MockState,
  MockTarget,
  Replaced,
  SpiedGetter,
  SpiedMethod,
  SpiedSetter,
  SpyableKeys,
  Stubs,
  UnknownFunction,
} from './types.ts'
