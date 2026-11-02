// @provino/bench: Provino's benchmark protocol (Track 12 R5) and its synthetic suites.
export {
  type CheckResult,
  checkProblems,
  checkRunner,
  failureMessages,
  parseTestSummary,
  type TestSummary,
} from './check.ts'
export { type CliCommand, parseCli, USAGE } from './cli-args.ts'
export { type CliDeps, type CliIo, runCli } from './commands.ts'
export { isCi, readEnvironment, readRunRef, requireCleanTree } from './environment.ts'
export { BenchError, type BenchErrorCode } from './errors.ts'
export {
  DEFAULT_RUN_TIMEOUT_MS,
  type ExecOutcome,
  type ExecProcess,
  type ExecRequest,
  execProcess,
  exitOnSignals,
  MAX_RUN_TIMEOUT_MS,
  parseTimes,
  TIMEOUT_EXIT_CODE,
  TIMES_WRAPPER,
} from './exec.ts'
export {
  APP_MAX_FILES,
  APP_TESTS_PER_FILE,
  appFiles,
} from './generators/app.ts'
export {
  buildGraph,
  GRAPH,
  GRAPH_SEED,
  GRAPH_SIZE,
  type GraphKind,
  type GraphNode,
  type Simulation,
  simulate,
} from './generators/graph.ts'
export {
  BIG_RECORD_COUNT,
  ISOLATE_HEAVY_FILES,
  ISOLATE_HEAVY_TESTS_PER_FILE,
  isolateHeavyFiles,
} from './generators/isolate-heavy.ts'
export {
  CONSUMER_COUNT,
  MOCK_HEAVY_MAX_FILES,
  MOCK_HEAVY_TESTS_PER_FILE,
  mockHeavyFiles,
} from './generators/mock-heavy.ts'
export {
  type Binding,
  FLAVOUR_DIR,
  FLAVOURS,
  type Flavour,
  type GeneratedFile,
} from './generators/render.ts'
export { prepareOutput, writeRecordFile } from './output.ts'
export {
  BENCH_LABELS,
  buildRecord,
  defaultMachineId,
  defaultOutPath,
  formatSummary,
  parseLabel,
} from './report.ts'
export {
  type BenchSpec,
  type BenchSubjectSpec,
  type CacheDir,
  type CacheKind,
  cacheDirProblem,
  DEFAULT_COLD_RUNS,
  DEFAULT_WARM_RUNS,
  MIN_CACHE_DIR_DEPTH,
  type RunEvent,
  type RunPhase,
  runBench,
  SPAWN_FAILED_EXIT_CODE,
} from './run-bench.ts'
export {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  type BootstrapOptions,
  bootstrapMedianCi,
  coefficientOfVariation,
  type Interval,
  max,
  mean,
  median,
  min,
  quantile,
  type RatioInterval,
  ratioCi,
  standardDeviation,
  wallStats,
} from './stats.ts'
export {
  buildSuite,
  expectedTests,
  PACKAGE_DIR,
  parseSuiteName,
  planRunner,
  REPO_ROOT,
  RESULTS_DIR,
  RUNNERS,
  type RunnerName,
  type RunnerPackage,
  type RunnerPlan,
  runnerPackage,
  SUITES_DIR,
  type SuiteKind,
  type SuiteSpec,
  suiteDir,
  toSubjectSpec,
  type WriteSummary,
  writeSuite,
} from './suites.ts'
export {
  createPsReader,
  type ProcessEntry,
  type ProcessTableReader,
  PS_TIMEOUT_MS,
  parseProcStatus,
  parsePsOutput,
  processTree,
  type RssSample,
  type RssSampler,
  type RssSamplerOptions,
  readProcessTable,
  readProcTable,
  readPsTable,
  startRssSampler,
  sumTreeRssMib,
  treeRss,
} from './tree-rss.ts'
