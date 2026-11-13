// @provino/lazy: RSpec-style lazy variables. Neutral: lazy semantics are the same in both dialects.
// The public functions forward to the runtime the worker installs in the `LAZY_RUNTIME_SLOT`.
export {
  evaluatedLazies,
  includeContext,
  includeExamples,
  itBehavesLike,
  lazy,
  sharedContext,
  sharedExamples,
} from './api.ts'
export {
  LAZY_CHAIN,
  LAZY_ERROR_CODES,
  LazyError,
  type LazyErrorCode,
  type LazyErrorOptions,
} from './errors.ts'
export {
  createLazyRuntime,
  type LazyCore,
  type LazyRuntimeOptions,
} from './runtime/create.ts'
export type { DescribeFn, SharedFunctions } from './runtime/shared.ts'
export {
  currentLazyRuntime,
  installLazyRuntime,
  LAZY_RUNTIME_SLOT,
  type LazyRuntime,
} from './slot.ts'
export type {
  AddKey,
  CheckKey,
  ContextOutput,
  DefineContext,
  EvaluatedLazy,
  HandleMethodKey,
  Lazy,
  LazyApi,
  LazyRoot,
  LetOptions,
  OverrideContext,
  ProtocolKey,
  ReservedKey,
  Scope,
  SharedContext,
  SharedExamples,
  SharedLazy,
  TaskInfo,
  TestContextLike,
  Values,
} from './types.ts'
