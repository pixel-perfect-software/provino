// The public API of @provino/reporters.
import {
  createReporterBus,
  type DefaultReporterOptions,
  defaultReporter,
  defineReporter,
  type NormalizedJsonReporterOptions,
  normalizedJsonReporter,
  type ReporterBusHandle,
  type TextSink,
} from '@provino/reporters'
import type {
  Reporter,
  ReporterBus,
  ReporterEvents,
  ReportPolicy,
  RunEnvironment,
  SerializedError,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The bus is the contract's `ReporterBus`, plus what went wrong inside it.
expectTypeOf<ReporterBusHandle>().toExtend<ReporterBus>()
expectTypeOf<ReporterBusHandle['failures']>().toEqualTypeOf<() => readonly SerializedError[]>()
expectTypeOf(createReporterBus).toEqualTypeOf<
  (reporters?: readonly Reporter[]) => ReporterBusHandle
>()
expectTypeOf(createReporterBus()).toEqualTypeOf<ReporterBusHandle>()

// emit checks the event's name and arguments.
declare const bus: ReporterBusHandle
expectTypeOf(bus.emit('error', { name: 'Error', message: 'm' }, 'reporter')).toEqualTypeOf<
  Promise<void>
>()
expectTypeOf(bus.emit).parameter(0).toEqualTypeOf<keyof ReporterEvents>()

// defineReporter keeps the literal name and takes handlers typed from the events.
const mine = defineReporter({
  name: 'mine',
  'file:end': (result) => {
    expectTypeOf(result.state).toEqualTypeOf<'pass' | 'fail' | 'skip'>()
  },
  'task:end': (task, event) => {
    expectTypeOf(task.type).toEqualTypeOf<'suite' | 'test'>()
    expectTypeOf(event.type).toEqualTypeOf<'suite-end' | 'test-end'>()
  },
  error: (error, origin) => {
    expectTypeOf(error).toEqualTypeOf<SerializedError>()
    expectTypeOf(origin).toEqualTypeOf<'coordinator' | 'reporter' | 'globalSetup'>()
  },
  lastError: () => undefined,
})
expectTypeOf(mine.name).toEqualTypeOf<'mine'>()
createReporterBus([mine])

// The built-ins are reporters, named for what they are.
declare const sink: TextSink
declare const report: ReportPolicy
expectTypeOf(defaultReporter({ stream: sink, report })).toEqualTypeOf<Reporter>()
expectTypeOf(
  normalizedJsonReporter({ suite: 's', runner: 'r', runnerVersion: '1' }),
).toEqualTypeOf<Reporter>()
expectTypeOf<NormalizedJsonReporterOptions['env']>().toEqualTypeOf<RunEnvironment | undefined>()
expectTypeOf<NormalizedJsonReporterOptions['ci']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<NormalizedJsonReporterOptions['unhandledErrors']>().toEqualTypeOf<
  'fail-run' | 'ignore' | undefined
>()
// @ts-expect-error -- only the orchestrator's two policy values
normalizedJsonReporter({ suite: 's', runner: 'r', runnerVersion: '1', unhandledErrors: 'warn' })
expectTypeOf<NormalizedJsonReporterOptions['stream']>().toEqualTypeOf<TextSink | undefined>()
expectTypeOf<DefaultReporterOptions['report']>().toEqualTypeOf<ReportPolicy>()
// Anything with a `write` is a sink: process.stdout, a buffer, a stream that returns a promise.
const sinks: readonly TextSink[] = [
  process.stdout,
  { write: (chunk: string) => chunk.length },
  { write: async (_chunk: string) => {} },
]
void sinks

// @ts-expect-error a misspelled event name
defineReporter({ name: 'typo', 'file:finished': () => {} })
// @ts-expect-error the handler's arguments are the event's: a file result, not a string
defineReporter({ name: 'wrong-args', 'file:end': (result: string) => result })
// @ts-expect-error a reporter needs a name
defineReporter({ 'run:end': () => {} })
// @ts-expect-error a handler returns nothing, or a promise of nothing
defineReporter({ name: 'returns', 'run:end': () => 3 })
// @ts-expect-error lastError returns an error or nothing
defineReporter({ name: 'last', lastError: () => 'text' })
// @ts-expect-error not a reporter: it has no name
createReporterBus([{ 'run:end': () => {} }])
// @ts-expect-error not a reporter at all
createReporterBus(['default'])
// @ts-expect-error the bus takes reporters, not one reporter
createReporterBus(mine)
// @ts-expect-error add takes a reporter
bus.add('default')
// @ts-expect-error not an event
bus.emit('file:finished')
// @ts-expect-error an event's arguments are required
bus.emit('file:end')
// @ts-expect-error the origin of an error event is one of three
bus.emit('error', { name: 'Error', message: 'm' }, 'nowhere')
// @ts-expect-error the default reporter needs its report policy
defaultReporter({ stream: sink })
// @ts-expect-error the default reporter needs somewhere to write
defaultReporter({ report })
// @ts-expect-error a sink writes strings
defaultReporter({ stream: { write: (chunk: number) => chunk }, report })
// @ts-expect-error normalized-json needs the identity of the run
normalizedJsonReporter({ outputFile: 'run.json' })
// @ts-expect-error the output file is a path
normalizedJsonReporter({ suite: 's', runner: 'r', runnerVersion: '1', outputFile: 3 })
// @ts-expect-error the environment is a RunEnvironment, not a name
normalizedJsonReporter({ suite: 's', runner: 'r', runnerVersion: '1', env: 'node' })
// @ts-expect-error ci is the run's answer, a boolean, not the CI variable's text
normalizedJsonReporter({ suite: 's', runner: 'r', runnerVersion: '1', ci: 'true' })
