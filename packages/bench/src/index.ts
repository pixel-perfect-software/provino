// @provino/bench: Provino's benchmark protocol (Track 12 R5) and its synthetic suites.
export { readRunRef } from './environment.ts'
export { BenchError, type BenchErrorCode } from './errors.ts'
export type { ExecOutcome, ExecProcess, ExecRequest } from './exec.ts'
export { buildRecord, LABEL_POLICY, type LabelPolicy, parseLabel } from './report.ts'
export {
  type BenchSpec,
  type BenchSubjectSpec,
  type CacheDir,
  type CacheKind,
  type RunEvent,
  type RunPhase,
  runBench,
} from './run-bench.ts'
export {
  type BootstrapOptions,
  type Interval,
  type RatioInterval,
  ratioCi,
  wallStats,
} from './stats.ts'
export {
  parseSuiteName,
  planRunner,
  type RunnerName,
  type RunnerPlan,
  type SuiteSpec,
} from './suites.ts'
export {
  type ProcessEntry,
  type ProcessTableReader,
  type RssSampler,
  startRssSampler,
  sumTreeRssMib,
} from './tree-rss.ts'
