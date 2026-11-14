// Track 9 §Types → "Type tests that gate CI" (T9.1), on the one event model: the wire and the
// reporter bus carry Track 5's RuntimeEvents.
import type {
  CloneSafe,
  CoordinatorMethods,
  CoordinatorToWorker,
  DefineReporter,
  FileHistory,
  FileInfo,
  FileResult,
  GlobalSetupContext,
  Inject,
  IsolationTier,
  OpenHandle,
  PoolOptions,
  ReporterBus,
  ReporterEvents,
  RpcCall,
  RpcClient,
  RpcReply,
  RpcSchema,
  RunEndReason,
  RuntimeEvent,
  RuntimeEventOf,
  SuiteTask,
  TaskState,
  TestTask,
  Transport,
  TransportFactory,
  WorkerEvent,
  WorkerExit,
  WorkerInit,
  WorkerKey,
  WorkerMethods,
  WorkerPort,
  WorkerToCoordinator,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare module '@provino/types' {
  interface ProvidedContext {
    dbUrl: string
    port: number
  }
}

declare const defineReporter: DefineReporter
declare const bus: ReporterBus
declare const ctx: GlobalSetupContext
declare const inject: Inject
declare const file: FileInfo
declare function assertNever(value: never): never

const r = defineReporter({
  name: 'mine',
  'task:end'(task, event) {
    expectTypeOf(task).toEqualTypeOf<SuiteTask | TestTask>()
    expectTypeOf(event.result.state).toEqualTypeOf<TaskState>()
    expectTypeOf<(typeof event.result.errors)[number]['message']>().toEqualTypeOf<string>()
  },
  'hook:start'(_owner, event) {
    expectTypeOf(event.ordinal).toEqualTypeOf<number>()
  },
  'run:end'(summary) {
    expectTypeOf(summary.reason).toEqualTypeOf<
      'passed' | 'failed' | 'interrupted' | 'terminated' | 'hangup'
    >()
    expectTypeOf(summary.openHandles).toEqualTypeOf<readonly OpenHandle[] | undefined>()
  },
})
expectTypeOf(r.name).toEqualTypeOf<'mine'>()
// @ts-expect-error unknown event name
defineReporter({ name: 'bad', 'test:finished'() {} })
// @ts-expect-error file:end takes exactly one FileResult
void bus.emit('file:end')

ctx.provide('dbUrl', 'postgres://x')
// @ts-expect-error wrong value type
ctx.provide('port', '3000')
expectTypeOf(inject('port')).toEqualTypeOf<number>()

expectTypeOf<RpcClient<CoordinatorMethods>['readTimings']>().returns.toEqualTypeOf<
  Promise<number | undefined>
>()
// @ts-expect-error workerExit is optional, not `| undefined`
const bad: FileResult = { file, state: 'pass', durationMs: 1, errors: [], workerExit: undefined }

// A file's snapshot report and a project's place among the run's projects are optional and clone-safe.
const withSnapshot: FileResult = {
  file,
  state: 'pass',
  durationMs: 1,
  errors: [],
  snapshot: {
    file: null,
    added: 0,
    matched: 1,
    unmatched: 0,
    updated: 0,
    unchecked: 0,
    uncheckedKeys: [],
    fileDeleted: false,
  },
}
const partialSnapshot: FileResult = {
  file,
  state: 'pass',
  durationMs: 1,
  errors: [],
  // @ts-expect-error a snapshot report has all its counters
  snapshot: { file: null },
}
expectTypeOf<FileResult>().toExtend<CloneSafe<FileResult>>()
expectTypeOf<FileInfo['projectIndex']>().toEqualTypeOf<number | undefined>()
// @ts-expect-error a project index is a number
const badIndex: FileInfo = { ...file, projectIndex: 'first' }
// @ts-expect-error exactOptionalPropertyTypes: omitted, not undefined
const undefinedIndex: FileInfo = { ...file, projectIndex: undefined }

export { badIndex, partialSnapshot, undefinedIndex, withSnapshot }

// One event model: the wire carries RuntimeEvents (plus the worker's own two), and every
// runtime-originated bus event hands reporters the RuntimeEvent itself.
expectTypeOf<RuntimeEvent>().toExtend<WorkerEvent>()
expectTypeOf<WorkerEvent>().toExtend<CloneSafe<WorkerEvent>>()

// Every wire message crosses a thread, now that the RPC payloads are typed (B09).
expectTypeOf<CoordinatorToWorker>().toExtend<CloneSafe<CoordinatorToWorker>>()
expectTypeOf<WorkerToCoordinator>().toExtend<CloneSafe<WorkerToCoordinator>>()
expectTypeOf<WorkerInit>().toExtend<CloneSafe<WorkerInit>>()
expectTypeOf<WorkerInit['captureConsole']>().toEqualTypeOf<true | undefined>()

// The RPC schemas: both method sets are clone-safe; a callback or a class result is not.
expectTypeOf<CoordinatorMethods>().toExtend<RpcSchema<CoordinatorMethods>>()
expectTypeOf<WorkerMethods>().toExtend<RpcSchema<WorkerMethods>>()
interface TakesCallback {
  subscribe(listener: () => void): void
}
expectTypeOf<RpcSchema<TakesCallback>['subscribe']>().toBeNever()
interface ReturnsMap {
  lookup(): Promise<Map<string, URL>>
}
expectTypeOf<RpcSchema<ReturnsMap>['lookup']>().toBeNever()

// Calls name a method and carry its arguments; replies carry a result of one of the methods.
type TimingsCall = Extract<RpcCall<CoordinatorMethods>, { method: 'readTimings' }>
expectTypeOf<TimingsCall['args']>().toEqualTypeOf<readonly [file: string]>()
expectTypeOf<Extract<WorkerToCoordinator, { t: 'call' }>>().toEqualTypeOf<
  RpcCall<CoordinatorMethods>
>()
expectTypeOf<Extract<CoordinatorToWorker, { t: 'call' }>>().toEqualTypeOf<RpcCall<WorkerMethods>>()
type CoordinatorReplyValue = Extract<RpcReply<CoordinatorMethods>, { ok: true }>['value']
// The worker asks the coordinator for one thing, a file's last duration. Snapshots are not an
// RPC: the worker writes the .snap itself (build-plan section 6).
expectTypeOf<CoordinatorReplyValue>().toEqualTypeOf<number | undefined>()
// @ts-expect-error a call names one of the methods
const unknownCall: RpcCall<CoordinatorMethods> = { t: 'call', id: 1, method: 'nope', args: [] }
const wrongArgs: RpcCall<CoordinatorMethods> = {
  t: 'call',
  id: 1,
  method: 'readTimings',
  // @ts-expect-error a call carries that method's arguments
  args: [1],
}

// `fileDone` always says which globals the file left behind (D22), as strings.
type FileDoneMessage = Extract<WorkerToCoordinator, { t: 'fileDone' }>
expectTypeOf<FileDoneMessage['leakedGlobals']>().toEqualTypeOf<readonly string[]>()
const fileDoneClean: FileDoneMessage = {
  t: 'fileDone',
  seq: 0,
  memoryBytes: 1,
  leakedHandles: 0,
  leakedGlobals: [],
}
// @ts-expect-error leakedGlobals is always present, empty when clean
const fileDoneWithout: FileDoneMessage = { t: 'fileDone', seq: 0, memoryBytes: 1, leakedHandles: 0 }
// @ts-expect-error the keys are strings
const fileDoneSymbols: FileDoneMessage = { ...fileDoneClean, leakedGlobals: [Symbol('x')] }

// A worker's port is the mirror of the transport.
expectTypeOf<Parameters<WorkerPort['send']>[0]>().toEqualTypeOf<WorkerToCoordinator>()
expectTypeOf<
  Parameters<Parameters<WorkerPort['onMessage']>[0]>[0]
>().toEqualTypeOf<CoordinatorToWorker>()
expectTypeOf<ReporterEvents['hook:start'][1]>().toEqualTypeOf<RuntimeEventOf<'hook-start'>>()
expectTypeOf<ReporterEvents['task:end'][1]>().toEqualTypeOf<
  RuntimeEventOf<'suite-end' | 'test-end'>
>()
expectTypeOf<ReporterEvents['console'][1]>().toEqualTypeOf<RuntimeEventOf<'console'>>()
expectTypeOf<ReporterEvents['unhandled'][1]>().toEqualTypeOf<RuntimeEventOf<'unhandled-error'>>()

/** Every worker event reaches the bus or is folded in by the coordinator; none is dropped. */
export function busEventFor(event: WorkerEvent): keyof ReporterEvents | null {
  switch (event.type) {
    case 'file-collect-start':
      return null // the coordinator already sent file:start
    case 'file-collect-end':
      return 'file:collected'
    case 'suite-start':
    case 'test-start':
      return 'task:start'
    case 'test-attempt-start':
      return 'test:attempt-start'
    case 'test-attempt-end':
      return 'test:attempt-end'
    case 'suite-end':
    case 'test-end':
      return 'task:end'
    case 'hook-start':
      return 'hook:start'
    case 'hook-end':
      return 'hook:end'
    case 'annotation':
      return 'annotation'
    case 'console':
      return 'console'
    case 'unhandled-error':
      return 'unhandled'
    case 'file-end':
      return 'file:end'
    case 'coverage':
      return null // merged, then reported once as `coverage`
    case 'deps':
      return null // feeds the watch-mode graph
    default:
      return assertNever(event)
  }
}

// U5: the modules a file loaded cross as the paths the worker had not sent and an id for each
// module, so the event carries numbers and strings only.
type DepsEvent = Extract<WorkerEvent, { readonly type: 'deps' }>
expectTypeOf<DepsEvent['added']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<DepsEvent['ids']>().toEqualTypeOf<readonly number[]>()
expectTypeOf<DepsEvent>().toExtend<CloneSafe<DepsEvent>>()
// @ts-expect-error the paths are no longer the event's list: `added` and `ids` replace `modules`
expectTypeOf<DepsEvent['modules']>()

// T9.5 and T9.10: a file's deadline, the memory a worker may hold, how a worker ends, how a run ends.
expectTypeOf<PoolOptions['fileTimeoutMs']>().toEqualTypeOf<number | undefined>()
expectTypeOf<PoolOptions['recycle']['memoryLimitBytes']>().toEqualTypeOf<number | undefined>()
expectTypeOf<PoolOptions['recycle']['maxFilesPerWorker']>().toEqualTypeOf<number | undefined>()
expectTypeOf<{ type: 'timeout'; phase: 'file'; limitMs: number }>().toExtend<WorkerExit>()
expectTypeOf<{ type: 'oom'; limitMb: number }>().toExtend<WorkerExit>()
// @ts-expect-error a timeout has a phase, and `run` is not one
const badPhase: WorkerExit = { type: 'timeout', phase: 'run', limitMs: 1 }
// @ts-expect-error a timeout carries the limit it ran out of
const noLimit: WorkerExit = { type: 'timeout', phase: 'file' }
// A pool ends a worker for a file's deadline through the transport; only that wait is its own.
expectTypeOf<Transport['terminate']>().parameters.toEqualTypeOf<
  [force: boolean, timeout?: { readonly phase: 'file'; readonly limitMs: number } | undefined]
>()
// @ts-expect-error the start and stop timeouts are the transport's own, not the pool's to name
const badTerminate: Parameters<Transport['terminate']>[1] = { phase: 'stop', limitMs: 1 }
expectTypeOf<TransportFactory['sharesProcess']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<'terminated'>().toExtend<RunEndReason>()
expectTypeOf<'hangup'>().toExtend<RunEndReason>()
// @ts-expect-error a run does not end `killed`
const badReason: RunEndReason = 'killed'
expectTypeOf<OpenHandle>().toEqualTypeOf<{
  readonly type: string
  readonly frames: readonly string[]
  readonly codeFrame?: string
}>()
// @ts-expect-error an open handle names the stack that made it
const noFrames: OpenHandle = { type: 'Timeout' }

// T9.6 and T2.11: the results cache's record has room for an inputs hash, a learned tier and a
// coverage map, and a worker key names its isolation tier.
expectTypeOf<WorkerKey['isolation']>().toEqualTypeOf<IsolationTier>()
expectTypeOf<FileHistory['inputsHash']>().toEqualTypeOf<string | undefined>()
expectTypeOf<FileHistory['tier']>().toEqualTypeOf<IsolationTier | undefined>()
expectTypeOf<FileHistory['coverage']>().toEqualTypeOf<
  Readonly<Record<string, readonly string[]>> | undefined
>()
const plainHistory: FileHistory = { durationMs: 1, failed: false, tests: 1, at: 0 }
const fullHistory: FileHistory = {
  ...plainHistory,
  inputsHash: 'abc',
  tier: 'realm',
  coverage: { 'a > b': ['f1'] },
}
// @ts-expect-error a learned tier is a tier
const badTier: FileHistory = { ...plainHistory, tier: 'jail' }
// @ts-expect-error exactOptionalPropertyTypes: leave the hash out, don't give it `undefined`
const undefinedHash: FileHistory = { ...plainHistory, inputsHash: undefined }
// @ts-expect-error a coverage entry lists function ids as text
const badCoverage: FileHistory = { ...plainHistory, coverage: { t: [1] } }
// @ts-expect-error a worker key needs its isolation tier
const keyWithoutTier: WorkerKey = {
  project: 'p',
  pool: 'forks',
  environment: 'node',
  environmentOptionsHash: '',
  execArgvHash: '',
  envHash: '',
}

export {
  bad,
  badCoverage,
  badPhase,
  badReason,
  badTerminate,
  badTier,
  fileDoneClean,
  fileDoneSymbols,
  fileDoneWithout,
  fullHistory,
  keyWithoutTier,
  noFrames,
  noLimit,
  undefinedHash,
  unknownCall,
  wrongArgs,
}
