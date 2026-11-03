// @provino/core: the test runtime (Track 5). Collector, executor, hooks, the test context and the
// current-test lookup, driven only by `CorePolicy`. It never imports the loader: the worker
// passes `ImportFile` (Track 1 §Module boundaries, rule 6).
export type {
  EachFunction,
  ForFunction,
  HookSuite,
  RuntimeApi,
  SuiteApi,
  SuiteBody,
  TestApi,
  TestFunction,
} from './collector/api.ts'
export type { SuiteOptions, TestOptions } from './collector/collector.ts'
export { type CurrentTestService, currentTest } from './current/current-test.ts'
export {
  AroundHookMultipleCallsError,
  AroundHookSetupError,
  AroundHookTeardownError,
  CoreError,
  type CoreErrorCode,
  serializeError,
} from './errors.ts'
export type { RealTimers } from './executor/deadline.ts'
export { createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts'
