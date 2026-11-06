// @provino/mock: mock functions, spies, replaced properties and stubs, with a per-file registry.
// Neutral: every Jest/Vitest difference is a `MockPolicy` value the dialect supplies.
export { MockError, MockTypeError } from './errors.ts'
export { createMockFn, isMockFunction, MOCK_BRAND } from './mock-fn.ts'
export {
  type AutomockMaker,
  type AutomockMode,
  automock,
} from './module/automock.ts'
export {
  type FindManualMockOptions,
  findManualMock,
  type ManualMock,
} from './module/manual-mocks.ts'
export type { ModuleMessageCode } from './module/messages.ts'
export {
  createModuleMockRegistry,
  type MockDecision,
  type ModuleMockRegistry,
  type ModuleMockRegistryOptions,
  type RegisterOptions,
} from './module/registry.ts'
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
