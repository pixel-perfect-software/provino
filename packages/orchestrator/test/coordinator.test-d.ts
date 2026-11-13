// The coordinator entry's public API: file ids, the run, discovery, the results cache, the
// sequencer, the pool, the worker key and the exit codes.
import type { ResolvedProject } from '@provino/config'
import {
  collectOpenHandles,
  createFileDispatch,
  createHistorySequencer,
  createPool,
  createResultsCache,
  type DiscoveredFile,
  defaultCacheDir,
  defaultMaxWorkers,
  defaultWorkerMemoryLimit,
  discoverByRules,
  discoverFiles,
  discoverProject,
  ExitCode,
  type ExitCodeOptions,
  exitCodeFor,
  type FileDispatch,
  type FileDone,
  type FileRequest,
  fileIdOf,
  isProvinoCacheDir,
  isRunSignal,
  type OpenHandleOptions,
  type OpenHandleTracker,
  OrchestratorError,
  type OrchestratorErrorCode,
  type Pool,
  type PoolDeps,
  type PoolErrorKind,
  type PoolOutcome,
  type ResultsCache,
  RUN_SIGNALS,
  type RunProjectOptions,
  type RunSignal,
  relativePosix,
  runProject,
  runProjects,
  sameWorkerKey,
  selectFiles,
  type TransportForOptions,
  testFilePredicate,
  transportFor,
  workerKeyOf,
} from '@provino/orchestrator'
import type {
  FileFilter,
  FileHistory,
  OpenHandle,
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
// @ts-expect-error the file deadline is a number of milliseconds
void runProject(project, { bus, pool: { fileTimeoutMs: '5s' } })
// @ts-expect-error the heap limit is a number of MB
void runProject(project, { bus, pool: { heapLimitMb: '256' } })
// @ts-expect-error bail takes a count, in an object (`RunRequest.bail`'s shape)
void runProject(project, { bus, bail: 2 })
// @ts-expect-error the signals are AbortSignals
void runProject(project, { bus, forceSignal: true })
void runProject(project, {
  bus,
  bail: { count: 2 },
  detectOpenHandles: true,
  signal: new AbortController().signal,
  forceSignal: new AbortController().signal,
  pool: {
    fileTimeoutMs: 5000,
    heapLimitMb: 256,
    recycle: { memoryLimitBytes: 0, maxFilesPerWorker: 3 },
  },
})

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
  readonly Sighup: 129
  readonly Sigint: 130
  readonly Sigterm: 143
}>()
// @ts-expect-error the codes are constants
ExitCode.Pass = 3
// The signals that end a run: one table, each with the reason of the summary and the exit code.
expectTypeOf<RunSignal>().toEqualTypeOf<'SIGINT' | 'SIGTERM' | 'SIGHUP'>()
expectTypeOf(RUN_SIGNALS.SIGHUP).toEqualTypeOf<{
  readonly reason: 'hangup'
  readonly exitCode: 129
}>()
expectTypeOf(isRunSignal).guards.toEqualTypeOf<RunSignal>()
// @ts-expect-error a signal that does not end a run has no entry
RUN_SIGNALS.SIGUSR1
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

// By a dialect reader's rules (B14c): the rules, what a glob sees, and a project's whole file set.
expectTypeOf(discoverByRules).returns.toEqualTypeOf<Promise<readonly DiscoveredFile[]>>()
expectTypeOf(discoverProject).parameters.toEqualTypeOf<[ResolvedProject]>()
expectTypeOf(discoverProject).returns.toEqualTypeOf<Promise<readonly DiscoveredFile[]>>()
expectTypeOf(testFilePredicate).returns.toEqualTypeOf<(absolutePath: string) => boolean>()
// @ts-expect-error the rules are required: without them there is nothing to apply
void discoverByRules({ rootDir: '/p', globMatchesOn: 'absolute-path' })
void discoverByRules({
  rootDir: '/p',
  // @ts-expect-error a glob sees the absolute path or the path from the root, nothing else
  globMatchesOn: 'basename',
  discovery: {
    roots: ['/p'],
    extensions: ['ts'],
    includePatterns: { kind: 'glob', patterns: [] },
    excludePatterns: [],
    crawlIgnorePatterns: [],
  },
})

// File filters from a command line narrow a run and a listing the same way.
expectTypeOf(selectFiles).returns.toEqualTypeOf<readonly DiscoveredFile[]>()
expectTypeOf<RunProjectOptions['fileFilters']>().toEqualTypeOf<readonly FileFilter[] | undefined>()
expectTypeOf<RunProjectOptions['cwd']>().toEqualTypeOf<string | undefined>()
void runProject(project, { bus, fileFilters: [{ kind: 'regex', value: 'a' }], cwd: '/p' })
// @ts-expect-error a filter has a kind
void runProject(project, { bus, fileFilters: [{ value: 'a' }] })
// @ts-expect-error filters need the root and the working directory
void selectFiles([], [], { rootDir: '/p' })

// ---- The results cache.
expectTypeOf(createResultsCache).parameters.toEqualTypeOf<[dir: string]>()
expectTypeOf(createResultsCache).returns.toEqualTypeOf<ResultsCache>()
expectTypeOf(isProvinoCacheDir).returns.toEqualTypeOf<boolean>()
expectTypeOf(isProvinoCacheDir).toBeCallableWith('/root/.cache/provino')
// @ts-expect-error the directory is a path
isProvinoCacheDir(1)
expectTypeOf(defaultCacheDir).returns.toEqualTypeOf<string>()
expectTypeOf(defaultCacheDir).toBeCallableWith('/root', '/ci/cache')
expectTypeOf(defaultCacheDir).toBeCallableWith('/root')
// @ts-expect-error the cache directory is a path
expectTypeOf(defaultCacheDir).toBeCallableWith('/root', 1)
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
expectTypeOf<Pool['cancelQueued']>().toEqualTypeOf<() => void>()
// T9.5, T9.10: a worker's memory limit has a default; a second Ctrl+C is a force signal; a file's
// end can be acted on before the worker takes another.
expectTypeOf(defaultWorkerMemoryLimit).toEqualTypeOf<(maxWorkers: number) => number>()
expectTypeOf<PoolDeps['forceSignal']>().toEqualTypeOf<AbortSignal | undefined>()
expectTypeOf<FileRequest['onDone']>().toEqualTypeOf<((done: FileDone) => void) | undefined>()
// @ts-expect-error `onDone` takes the file's `fileDone` message
const wrongDone: FileRequest['onDone'] = (done: string) => void done
void wrongDone
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
// A fork has the same limit (T9.5): `--max-old-space-size`.
transportFor('forks', { entry: '/w.ts', memoryLimitMb: 64 })

// ---- Open handles (T9.10).
expectTypeOf(collectOpenHandles).parameters.toEqualTypeOf<[OpenHandleOptions]>()
expectTypeOf(collectOpenHandles).returns.toEqualTypeOf<OpenHandleTracker>()
expectTypeOf<OpenHandleTracker['collect']>().returns.toEqualTypeOf<Promise<OpenHandle[]>>()
expectTypeOf<OpenHandleTracker['dispose']>().returns.toEqualTypeOf<void>()
// @ts-expect-error a tracker is not called: it has `collect` and `dispose`
collectOpenHandles({ roots: ['/project'] })()
collectOpenHandles({ roots: ['/project'] })
// @ts-expect-error the roots are required: without them nothing is the user's
collectOpenHandles({})
// @ts-expect-error roots are paths
collectOpenHandles({ roots: [1] })
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

// ---- runProjects (D29): several resolved projects through one pool.
expectTypeOf(runProjects).parameters.toEqualTypeOf<
  [readonly ResolvedProject[], RunProjectOptions]
>()
expectTypeOf(runProjects).returns.toEqualTypeOf<Promise<RunSummary>>()
void runProjects([project, project], { bus, root: '/repo' })
// @ts-expect-error a list of projects, not one
void runProjects(project, { bus })
// @ts-expect-error the run's root is a path
void runProjects([project], { bus, root: 3 })
expectTypeOf<OrchestratorErrorCode>().toExtend<string>()
