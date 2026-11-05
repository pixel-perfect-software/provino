// provino/node: run a project's tests from code, as `provino run` does. The rest of Track 1's
// `provino/node` (`createProvino()`, `resolveConfig()`, event types) is not built yet.
export { run } from './run.ts'
export type {
  NormalizedJsonChoiceOptions,
  ReporterChoice,
  RunOptions,
  RunResult,
} from './types.ts'
