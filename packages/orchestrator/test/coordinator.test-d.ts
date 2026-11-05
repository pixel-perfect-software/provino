// The coordinator entry's public API: file ids, the run, discovery, the results cache, the
// sequencer, the pool, the worker key and the exit codes.
import type { ResolvedProject } from '@provino/config'
import {
  createFileDispatch,
  createHistorySequencer,
  createPool,
  createResultsCache,
  type DiscoveredFile,
  defaultCacheDir,
  defaultMaxWorkers,
  discoverFiles,
  ExitCode,
  type ExitCodeOptions,
  exitCodeFor,
  type FileDispatch,
  fileIdOf,
  OrchestratorError,
  type OrchestratorErrorCode,
  type Pool,
  type PoolDeps,
  type PoolErrorKind,
  type PoolOutcome,
  type ResultsCache,
  type RunProjectOptions,
  relativePosix,
  runProject,
  sameWorkerKey,
  type TransportForOptions,
  transportFor,
  workerKeyOf,
} from '@provino/orchestrator'
import type {
  FileHistory,
  PoolKind,
  PoolOptions,
  ReporterBus,
  RunSummary,
  Sequencer,
  TaskId,
  TransportFactory,
  WorkerExit,
  WorkerKey,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const bus: ReporterBus
declare const project: ResolvedProject
declare const summary: RunSummary
declare const poolOptions: PoolOptions
declare const poolDeps: PoolDeps

// A file's id is a `TaskId` made from the project name and the file's relative path (D23).
expectTypeOf(fileIdOf).parameters.toEqualTypeOf<[project: string, relativePath: string]>()
expectTypeOf(fileIdOf).returns.toEqualTypeOf<TaskId>()

// @ts-expect-error the relative path is required: the id is made of both
fileIdOf('web')
// @ts-expect-error the project name is a string
fileIdOf(undefined, 'a.test.ts')

// A file's path relative to the root, with POSIX separators.
expectTypeOf(relativePosix).parameters.toEqualTypeOf<[rootDir: string, file: string]>()
expectTypeOf(relativePosix).returns.toEqualTypeOf<string>()
// @ts-expect-error both the root and the file are required
relativePosix('/p')
// @ts-expect-error a path, not a URL
relativePosix('/p', new URL('file:///p/a.test.ts'))

// ---- runProject: a resolved project and a bus in, a summary out.
expectTypeOf(runProject).parameters.toEqualTypeOf<[ResolvedProject, RunProjectOptions]>()
expectTypeOf(runProject).returns.toEqualTypeOf<Promise<RunSummary>>()
expectTypeOf<RunProjectOptions['bus']>().toEqualTypeOf<ReporterBus>()
expectTypeOf<RunProjectOptions['cache']>().toEqualTypeOf<ResultsCache | false | undefined>()
expectTypeOf<RunProjectOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>()
void runProject(project, { bus })
void runProject(project, { bus, cache: false, testNamePattern: 'works', pool: { maxWorkers: 2 } })
// @ts-expect-error the bus is required: every event goes through it
void runProject(project, {})
// @ts-expect-error a project is a `ResolvedProject`, not a path to a config file
void runProject('provino.config.ts', { bus })
// @ts-expect-error the cache is a `ResultsCache` or `false`; `true` has no directory to use
void runProject(project, { bus, cache: true })
// @ts-expect-error the pool kind is one of forks, threads and inline
void runProject(project, { bus, pool: { kind: 'processes' } })
// @ts-expect-error the test name pattern is a string (it is compiled here, once)
void runProject(project, { bus, testNamePattern: /works/ })
// @ts-expect-error recycle policies take numbers
void runProject(project, { bus, pool: { recycle: { maxFilesPerWorker: '10' } } })

// ---- Errors carry a code from a closed set.
expectTypeOf<OrchestratorError['code']>().toEqualTypeOf<OrchestratorErrorCode>()
expectTypeOf<'ORCH_BAD_PATTERN'>().toExtend<OrchestratorErrorCode>()
expectTypeOf<'ORCH_NOT_IMPLEMENTED'>().toExtend<OrchestratorErrorCode>()
expectTypeOf<'ORCH_BAD_EVENT'>().toExtend<OrchestratorErrorCode>()
// @ts-expect-error a code outside the set
new OrchestratorError('ORCH_BAD_CONFIG', 'that code belongs to the worker')

// ---- Exit codes: Track 9's constants, and a function of the summary and the policy.
expectTypeOf(ExitCode).toEqualTypeOf<{
  readonly Pass: 0
  readonly TestFailure: 1
  readonly UsageError: 2
  readonly Sigint: 130
  readonly Sigterm: 143
}>()
// @ts-expect-error the codes are constants
ExitCode.Pass = 3
expectTypeOf(exitCodeFor).parameters.toEqualTypeOf<[RunSummary, ExitCodeOptions]>()
expectTypeOf(exitCodeFor).returns.toEqualTypeOf<number>()
exitCodeFor(summary, { policy: project.policy })
exitCodeFor(summary, { policy: project.policy, passWithNoTests: true, reporterFailures: [] })
// @ts-expect-error the policy gives the exit codes, so it is required
exitCodeFor(summary, {})
// @ts-expect-error the summary comes first
exitCodeFor({ policy: project.policy })
// @ts-expect-error passWithNoTests is a boolean
exitCodeFor(summary, { policy: project.policy, passWithNoTests: 'yes' })

// ---- Discovery.
expectTypeOf(discoverFiles).returns.toEqualTypeOf<Promise<readonly DiscoveredFile[]>>()
expectTypeOf<DiscoveredFile>().toEqualTypeOf<{
  readonly path: string
  readonly relativePath: string
  readonly sizeBytes: number
}>()
void discoverFiles({ rootDir: '/p', include: ['**/*.test.ts'], exclude: [] })
// @ts-expect-error all three are required: the globs have no defaults here, the policy has them
void discoverFiles({ rootDir: '/p' })
// @ts-expect-error a glob list, not one glob
void discoverFiles({ rootDir: '/p', include: '**/*.test.ts', exclude: [] })

// ---- The results cache.
expectTypeOf(createResultsCache).parameters.toEqualTypeOf<[dir: string]>()
expectTypeOf(createResultsCache).returns.toEqualTypeOf<ResultsCache>()
expectTypeOf(defaultCacheDir).returns.toEqualTypeOf<string>()
expectTypeOf<ResultsCache['get']>().toEqualTypeOf<
  (project: string, path: string) => FileHistory | undefined
>()
expectTypeOf<ResultsCache['write']>().toEqualTypeOf<() => Promise<void>>()
expectTypeOf<ResultsCache['prune']>().toEqualTypeOf<
  (project: string, keep: ReadonlySet<string>) => void
>()
declare const cache: ResultsCache
cache.record('web', 'a.test.ts', { durationMs: 1, failed: false, tests: 1, at: 0 })
// @ts-expect-error a history has all four fields
cache.record('web', 'a.test.ts', { durationMs: 1 })
cache.prune('web', new Set(['a.test.ts']))
// @ts-expect-error `keep` is the project's whole file set, a Set, not one path
cache.prune('web', 'a.test.ts')
// @ts-expect-error `prune` needs the project's name
cache.prune(new Set(['a.test.ts']))
// @ts-expect-error the directory is a path
createResultsCache()

// ---- The sequencer.
expectTypeOf(createHistorySequencer).returns.toEqualTypeOf<Sequencer>()
createHistorySequencer({ unknownFirst: true })
// @ts-expect-error unknownFirst has no default: it is the dialect's policy
createHistorySequencer({})
// @ts-expect-error a boolean
createHistorySequencer({ unknownFirst: 'yes' })

// ---- The pool.
expectTypeOf(createPool).parameters.toEqualTypeOf<[PoolOptions, PoolDeps]>()
expectTypeOf(createPool).returns.toEqualTypeOf<Pool>()
expectTypeOf(defaultMaxWorkers).returns.toEqualTypeOf<number>()
expectTypeOf<Pool['run']>().returns.toEqualTypeOf<Promise<PoolOutcome>>()
expectTypeOf<Pool['close']>().returns.toEqualTypeOf<Promise<void>>()
expectTypeOf<Pool['drain']>().toEqualTypeOf<() => void>()
// The pool's error callback is told whether a worker was lost.
expectTypeOf<PoolErrorKind>().toEqualTypeOf<'worker-lost' | 'other'>()
expectTypeOf<NonNullable<PoolDeps['onError']>>().toEqualTypeOf<
  (error: unknown, kind: PoolErrorKind) => void
>()
// @ts-expect-error the kind is a closed set
const lost: PoolErrorKind = 'crashed'
void lost
// A transport can cap the pool; the inline one does.
expectTypeOf<TransportFactory['maxWorkers']>().toEqualTypeOf<number | undefined>()
// ---- The transport for a pool kind.
expectTypeOf(transportFor).parameters.toEqualTypeOf<
  [kind: PoolKind, options: TransportForOptions]
>()
expectTypeOf(transportFor).returns.toEqualTypeOf<TransportFactory>()
transportFor('threads', { entry: '/w.ts', memoryLimitMb: 64 })
transportFor('forks', { entry: new URL('file:///w.ts'), execArgv: [] })
// @ts-expect-error the worker entry is required
transportFor('inline', {})
// @ts-expect-error a kind is forks, threads or inline
transportFor('processes', { entry: '/w.ts' })
// @ts-expect-error the thread's heap limit is a number of megabytes
transportFor('threads', { entry: '/w.ts', memoryLimitMb: '64' })
// @ts-expect-error a pool is made with its options and what it needs from the run
createPool(poolOptions)
// @ts-expect-error `PoolDeps.transport` takes the kind and returns a factory
createPool(poolOptions, { ...poolDeps, transport: 'forks' })

// A pool outcome is a closed union: every case is handled, or the `never` check fails.
function describeOutcome(outcome: PoolOutcome): string {
  switch (outcome.type) {
    case 'done':
      expectTypeOf(outcome.workerId).toEqualTypeOf<number>()
      return `done on ${outcome.workerId}`
    case 'crashed':
      expectTypeOf(outcome.exit).toEqualTypeOf<WorkerExit>()
      return 'crashed'
    case 'failed':
      return 'failed'
    case 'start-failed':
      expectTypeOf(outcome.workerId).toEqualTypeOf<number>()
      expectTypeOf(outcome.exit).toEqualTypeOf<WorkerExit | undefined>()
      return 'start-failed'
    case 'aborted':
      return 'aborted'
    default:
      return outcome satisfies never
  }
}
describeOutcome({ type: 'aborted' })

// ---- The worker key.
expectTypeOf(workerKeyOf).returns.toEqualTypeOf<WorkerKey>()
expectTypeOf(sameWorkerKey).returns.toEqualTypeOf<boolean>()
workerKeyOf({
  project: 'web',
  pool: 'forks',
  environment: 'node',
  environmentOptions: { url: 'http://localhost' },
  execArgv: [],
})
workerKeyOf({
  project: 'web',
  pool: 'forks',
  environment: 'node',
  environmentOptions: {},
  execArgv: [],
  env: { TZ: 'UTC' },
})
expectTypeOf<Parameters<typeof workerKeyOf>[0]['pool']>().toEqualTypeOf<PoolKind>()
const keyInput = {
  project: 'p',
  pool: 'forks',
  environment: 'node',
  environmentOptions: {},
  execArgv: [],
} as const
// @ts-expect-error the pool is a kind
workerKeyOf({ ...keyInput, pool: 'processes' })
// @ts-expect-error environment options are JSON values: a function can't be hashed or cloned
workerKeyOf({ ...keyInput, environmentOptions: { f: () => {} } })
// @ts-expect-error execArgv is part of the key
workerKeyOf({ project: 'p', pool: 'forks', environment: 'node', environmentOptions: {} })

// ---- Dispatch.
expectTypeOf(createFileDispatch).returns.toEqualTypeOf<FileDispatch>()
expectTypeOf<FileDispatch['handle']>().returns.toEqualTypeOf<Promise<void>>()
// @ts-expect-error a dispatch is made for one file, with the bus and a handler for unhandled errors
createFileDispatch({ bus })
