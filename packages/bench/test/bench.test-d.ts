import {
  BenchError,
  type BenchErrorCode,
  type BenchSpec,
  type BenchSubjectSpec,
  type BootstrapOptions,
  buildRecord,
  type CacheDir,
  type CacheKind,
  type ExecOutcome,
  type ExecProcess,
  type ExecRequest,
  evaluateKillCheck,
  formatKillCheck,
  type Interval,
  ISOLATION_SUITE,
  type IsolationCheck,
  KILL_CRITERION,
  type KillCheckSuite,
  type KillCheckVerdict,
  type KillCriterion,
  LABEL_POLICY,
  type LabelPolicy,
  type ParityCheck,
  type ProcessEntry,
  type ProcessTableReader,
  parseLabel,
  parseSuiteName,
  planRunner,
  R6_SUITES,
  type RatioInterval,
  type RssSampler,
  type RunEvent,
  type RunnerName,
  type RunnerPlan,
  type RunPhase,
  ratioCi,
  readRunRef,
  runBench,
  type SpeedCheck,
  type StatusParity,
  type SuiteSpec,
  type SuiteVerdict,
  startRssSampler,
  sumTreeRssMib,
  wallStats,
} from '@provino/bench'
import type {
  BenchLabel,
  BenchRecord,
  BenchResult,
  BenchSubject,
  IsolationMode,
  RunEnvironment,
  RunRef,
  WallStats,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// Misuse cases pass the bad value through this, so each `@ts-expect-error` has one cause.
declare function accept<T>(value: T): void

const subject: BenchSubject = {
  runner: 'jest',
  version: '30.5.2',
  isolation: 'runner-default',
  command: 'run jest',
}

// runBench takes a spec and gives back results from @provino/types.
expectTypeOf(runBench).parameter(0).toEqualTypeOf<BenchSpec>()
expectTypeOf(runBench).returns.toEqualTypeOf<Promise<readonly BenchResult[]>>()

const cache: CacheDir = { kind: 'jest', path: '/tmp/cache' }
expectTypeOf<CacheKind>().toEqualTypeOf<'jest' | 'vite' | 'provino' | 'node-compile'>()
const subjectSpec: BenchSubjectSpec = { subject, argv: ['jest'], cwd: '/tmp', caches: [cache] }
expectTypeOf(subjectSpec.env).toEqualTypeOf<Readonly<Record<string, string>> | undefined>()
runBench({ benchId: 'app-50', subjects: [subjectSpec], warmRuns: 2, coldRuns: 1 })
// @ts-expect-error a bad cache kind
accept<CacheDir>({ kind: 'webpack', path: '/tmp/cache' })
// @ts-expect-error a cache dir needs a path
accept<CacheDir>({ kind: 'jest' })
// @ts-expect-error a bench needs a suite name
runBench({ subjects: [subjectSpec] })
// @ts-expect-error a bench needs subjects
runBench({ benchId: 'app-50' })
// @ts-expect-error run counts are numbers
runBench({ benchId: 'app-50', subjects: [subjectSpec], warmRuns: '10' })
// @ts-expect-error a subject spec needs its caches
accept<BenchSubjectSpec>({ subject, argv: ['jest'], cwd: '/tmp' })

// The process runner is injectable.
expectTypeOf<ExecProcess>().toEqualTypeOf<(request: ExecRequest) => Promise<ExecOutcome>>()
const fake: ExecProcess = async () => ({ exitCode: 0, wallMs: 1 })
runBench({ benchId: 'app-50', subjects: [subjectSpec], exec: fake })
// @ts-expect-error an outcome needs a wall time
accept<ExecOutcome>({ exitCode: 0 })
// @ts-expect-error the exit code is a number
accept<ExecOutcome>({ exitCode: '0', wallMs: 1 })
// @ts-expect-error an exec must return a promise
accept<ExecProcess>(() => ({ exitCode: 0, wallMs: 1 }))

expectTypeOf<RunPhase>().toEqualTypeOf<'warm-up' | 'warm' | 'cold'>()
expectTypeOf<RunEvent['subject']>().toEqualTypeOf<BenchSubject>()

// Statistics.
expectTypeOf(wallStats).returns.toEqualTypeOf<WallStats>()
expectTypeOf(ratioCi).returns.toEqualTypeOf<RatioInterval>()
expectTypeOf<RatioInterval>().toExtend<Interval>()
expectTypeOf<BootstrapOptions>().toEqualTypeOf<{
  readonly resamples?: number
  readonly seed?: number
}>()
wallStats([1, 2, 3], { resamples: 100, seed: 1 })
// @ts-expect-error samples are numbers
wallStats(['1', '2'])
// @ts-expect-error resamples is a number
wallStats([1, 2], { resamples: '2000' })
// @ts-expect-error ratioCi takes two sample lists
ratioCi([1, 2])

// Labels are the three from the benchmark rules, and each has one policy row.
declare const environment: RunEnvironment
expectTypeOf(parseLabel).returns.toEqualTypeOf<BenchLabel>()
expectTypeOf(buildRecord).returns.toEqualTypeOf<BenchRecord>()
expectTypeOf(LABEL_POLICY).toEqualTypeOf<Readonly<Record<BenchLabel, LabelPolicy>>>()
expectTypeOf<LabelPolicy>().toEqualTypeOf<{
  readonly minWarm: number
  readonly minCold: number
  readonly requireClean: boolean
  readonly note: string
}>()
// @ts-expect-error a label policy needs all four rules
accept<LabelPolicy>({ minWarm: 1, minCold: 1, requireClean: false })
// @ts-expect-error the minimum is a number
accept<LabelPolicy>({ minWarm: '10', minCold: 5, requireClean: true, note: 'x' })
declare const policy: LabelPolicy
// @ts-expect-error a policy is read-only
policy.minWarm = 5
// @ts-expect-error only the three labels have a policy
accept(LABEL_POLICY.production)
buildRecord({
  label: 'local',
  ref: { sha: 'a', date: '2026-11-02T00:00:00.000Z', dirty: false },
  environment,
  machineId: 'local-darwin-arm64',
  results: [],
})
buildRecord({
  // @ts-expect-error a bad label
  label: 'production',
  ref: { sha: 'a', date: '2026-11-02T00:00:00.000Z', dirty: false },
  environment,
  machineId: 'x',
  results: [],
})
buildRecord({
  label: 'local',
  // @ts-expect-error a ref must say whether the tree was dirty
  ref: { sha: 'a', date: '2026-11-02T00:00:00.000Z' },
  environment,
  machineId: 'x',
  results: [],
})
expectTypeOf(readRunRef).returns.toEqualTypeOf<RunRef>()

// Process trees.
expectTypeOf<ProcessTableReader>().toEqualTypeOf<() => Promise<readonly ProcessEntry[]>>()
expectTypeOf(sumTreeRssMib).returns.toEqualTypeOf<number>()
expectTypeOf(startRssSampler).returns.toEqualTypeOf<RssSampler>()
startRssSampler(1, { intervalMs: 25 })
// @ts-expect-error the interval is a number
startRssSampler(1, { intervalMs: '25' })
declare const entry: ProcessEntry
// @ts-expect-error entries are read-only
entry.rssKib = 1

// Suites and plans.
expectTypeOf(parseSuiteName).returns.toEqualTypeOf<SuiteSpec>()
expectTypeOf<SuiteSpec['kind']>().toEqualTypeOf<'app' | 'mock-heavy' | 'isolate-heavy'>()
expectTypeOf(planRunner).returns.toEqualTypeOf<RunnerPlan>()
planRunner(parseSuiteName('app-5'), 'jest')
planRunner(parseSuiteName('app-5'), 'vitest')
planRunner(parseSuiteName('app-5'), 'provino')
planRunner(parseSuiteName('app-5'), 'jest', { extraArgs: ['--json'] })
planRunner(parseSuiteName('app-5'), 'provino', { isolation: 'none' })
// @ts-expect-error Provino's tiers here are registry and none
planRunner(parseSuiteName('app-5'), 'provino', { isolation: 'realm' })
expectTypeOf<RunnerPlan['isolation']>().toEqualTypeOf<IsolationMode>()
expectTypeOf<RunnerName>().toEqualTypeOf<'jest' | 'vitest' | 'provino'>()
expectTypeOf<RunnerPlan['runner']>().toEqualTypeOf<RunnerName>()
// @ts-expect-error only Jest, Vitest and Provino are runners
planRunner(parseSuiteName('app-5'), 'mocha')
// @ts-expect-error extra arguments are strings
planRunner(parseSuiteName('app-5'), 'jest', { extraArgs: [1] })

// Errors carry a stable code.
expectTypeOf<BenchError['code']>().toEqualTypeOf<BenchErrorCode>()
new BenchError('BENCH_INVALID_SPEC', 'message')
// @ts-expect-error not a bench error code
new BenchError('BENCH_NOPE', 'message')

// The kill-check's gate is a pure function of a record, the suites and the parity reads.
declare const killRecord: BenchRecord
declare const parity: StatusParity
expectTypeOf(evaluateKillCheck).returns.toEqualTypeOf<KillCheckVerdict>()
expectTypeOf(formatKillCheck).returns.toEqualTypeOf<readonly string[]>()
expectTypeOf(KILL_CRITERION).toEqualTypeOf<KillCriterion>()
expectTypeOf(R6_SUITES).toEqualTypeOf<readonly KillCheckSuite[]>()
expectTypeOf(ISOLATION_SUITE).toEqualTypeOf<string>()
expectTypeOf<KillCheckVerdict['outcome']>().toEqualTypeOf<'GO' | 'NO-GO'>()
expectTypeOf<IsolationCheck['cache']>().toEqualTypeOf<'warm' | 'cold'>()
evaluateKillCheck({
  record: killRecord,
  suites: R6_SUITES,
  parity: new Map([['app-500', parity]]),
  dryRun: false,
})
// @ts-expect-error a dry run flag is required
evaluateKillCheck({ record: killRecord, suites: R6_SUITES, parity: new Map() })
// @ts-expect-error parity is a map by suite name, not a list
evaluateKillCheck({ record: killRecord, suites: R6_SUITES, parity: [parity], dryRun: false })
// @ts-expect-error a pending reason is a string
accept<KillCheckSuite>({ name: 'mobx', pending: 1 })
// @ts-expect-error a suite needs a name
accept<KillCheckSuite>({ pending: 'later' })
// @ts-expect-error the criterion is read-only
KILL_CRITERION.warmMaxRatio = 1
declare const verdictValue: KillCheckVerdict
// @ts-expect-error a verdict is read-only
verdictValue.outcome = 'GO'
// A suite is either pending with a reason or measured with its three checks, never both.
declare const suiteVerdict: SuiteVerdict
if ('pending' in suiteVerdict) {
  expectTypeOf(suiteVerdict.pending).toEqualTypeOf<string>()
  // @ts-expect-error a pending suite has no warm check
  suiteVerdict.warm
} else {
  expectTypeOf(suiteVerdict.warm).toEqualTypeOf<SpeedCheck>()
  expectTypeOf(suiteVerdict.parity).toEqualTypeOf<ParityCheck>()
}
// @ts-expect-error only a verdict formats
formatKillCheck(killRecord)
