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
  type Interval,
  type ProcessEntry,
  type ProcessTableReader,
  parseLabel,
  parseSuiteName,
  planRunner,
  type RatioInterval,
  type RssSampler,
  type RunEvent,
  type RunnerPlan,
  type RunPhase,
  ratioCi,
  readEnvironment,
  readRunRef,
  runBench,
  type SuiteSpec,
  startRssSampler,
  sumTreeRssMib,
  wallStats,
} from '@provino/bench'
import type {
  BenchLabel,
  BenchRecord,
  BenchResult,
  BenchSubject,
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

// Labels are the three from the benchmark rules.
expectTypeOf(parseLabel).returns.toEqualTypeOf<BenchLabel>()
expectTypeOf(buildRecord).returns.toEqualTypeOf<BenchRecord>()
buildRecord({
  label: 'local',
  ref: { sha: 'a', date: '2026-11-02T00:00:00.000Z', dirty: false },
  environment: readEnvironment({}),
  machineId: 'local-darwin-arm64',
  results: [],
})
buildRecord({
  // @ts-expect-error a bad label
  label: 'production',
  ref: { sha: 'a', date: '2026-11-02T00:00:00.000Z', dirty: false },
  environment: readEnvironment({}),
  machineId: 'x',
  results: [],
})
buildRecord({
  label: 'local',
  // @ts-expect-error a ref must say whether the tree was dirty
  ref: { sha: 'a', date: '2026-11-02T00:00:00.000Z' },
  environment: readEnvironment({}),
  machineId: 'x',
  results: [],
})
expectTypeOf(readEnvironment).returns.toEqualTypeOf<RunEnvironment>()
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
// @ts-expect-error only Jest and Vitest are subjects
planRunner(parseSuiteName('app-5'), 'mocha')

// Errors carry a stable code.
expectTypeOf<BenchError['code']>().toEqualTypeOf<BenchErrorCode>()
new BenchError('BENCH_INVALID_SPEC', 'message')
// @ts-expect-error not a bench error code
new BenchError('BENCH_NOPE', 'message')
