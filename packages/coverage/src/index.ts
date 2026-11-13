// @provino/coverage: code coverage. The root entry holds what both processes share; the worker's
// instrumenter and collectors are `./runtime`, the coordinator's merge, reports and thresholds
// `./node`. A run loads them only when it turns coverage on.
export { CoverageError, type CoverageErrorCode } from './errors.ts'
