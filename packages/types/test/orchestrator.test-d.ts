// Track 9 §Types → "Type tests that gate CI" (T9.1), on the one event model: the wire and the
// reporter bus carry Track 5's RuntimeEvents.
import type {
  CloneSafe,
  CoordinatorMethods,
  CoordinatorToWorker,
  DefineReporter,
  FileInfo,
  FileResult,
  GlobalSetupContext,
  Inject,
  ReporterBus,
  ReporterEvents,
  RpcClient,
  RuntimeEvent,
  RuntimeEventOf,
  SuiteTask,
  TaskState,
  TestTask,
  WorkerEvent,
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
    expectTypeOf(summary.reason).toEqualTypeOf<'passed' | 'failed' | 'interrupted'>()
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

// One event model: the wire carries RuntimeEvents (plus the worker's own two), and every
// runtime-originated bus event hands reporters the RuntimeEvent itself.
expectTypeOf<RuntimeEvent>().toExtend<WorkerEvent>()
expectTypeOf<WorkerEvent>().toExtend<CloneSafe<WorkerEvent>>()
type RunMessage = Extract<CoordinatorToWorker, { t: 'run' }>
expectTypeOf<RunMessage>().toExtend<CloneSafe<RunMessage>>()
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

export { bad }
