// The public API of @provino/reporters.
import {
  AGENT_VARIABLES,
  agentReporter,
  createReporterBus,
  createStyle,
  type DefaultReporterOptions,
  type DetectOptions,
  defaultReporter,
  defineReporter,
  detectOutput,
  dotReporter,
  type GitHubActionsReporterOptions,
  githubActionsReporter,
  type JUnitReporterOptions,
  jsonReporter,
  junitReporter,
  type NormalizedJsonReporterOptions,
  normalizedJsonReporter,
  type OutputEnvironment,
  type OutputStream,
  type ReporterBusHandle,
  type Style,
  type TextReporterOptions,
  type TextSink,
  verboseReporter,
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

// The text reporters share their options; the default one has had them all along.
expectTypeOf<DefaultReporterOptions>().toEqualTypeOf<TextReporterOptions>()
expectTypeOf<TextReporterOptions['colour']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<TextReporterOptions['live']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<TextReporterOptions['columns']>().toEqualTypeOf<number | undefined>()
expectTypeOf<TextReporterOptions['silent']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<TextReporterOptions['noStackTrace']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<TextReporterOptions['expand']>().toEqualTypeOf<boolean | undefined>()
for (const make of [verboseReporter, dotReporter, agentReporter]) {
  expectTypeOf(make({ stream: sink, report })).toEqualTypeOf<Reporter>()
}
// @ts-expect-error the text reporters need their report policy
verboseReporter({ stream: sink })
// @ts-expect-error colour is a flag, not the FORCE_COLOR text
dotReporter({ stream: sink, report, colour: 'always' })
// @ts-expect-error the width is a number
agentReporter({ stream: sink, report, columns: '80' })

// json is the normalized-json reporter's options under another name.
expectTypeOf(jsonReporter).toEqualTypeOf<typeof normalizedJsonReporter>()
// @ts-expect-error json needs the identity of the run, as normalized-json does
jsonReporter({ outputFile: 'run.json' })

// junit takes the report policy for its separator, and a file or a sink.
expectTypeOf(junitReporter({ report, outputFile: 'junit.xml' })).toEqualTypeOf<Reporter>()
expectTypeOf<JUnitReporterOptions['name']>().toEqualTypeOf<string | undefined>()
expectTypeOf<JUnitReporterOptions['now']>().toEqualTypeOf<(() => number) | undefined>()
// @ts-expect-error junit needs the report policy
junitReporter({ outputFile: 'junit.xml' })
// @ts-expect-error the output file is a path
junitReporter({ report, outputFile: 3 })

expectTypeOf(githubActionsReporter({ stream: sink, report })).toEqualTypeOf<Reporter>()
expectTypeOf<GitHubActionsReporterOptions['workspace']>().toEqualTypeOf<string | undefined>()
// @ts-expect-error github-actions needs somewhere to write
githubActionsReporter({ report })

// What detectOutput reads and gives back.
expectTypeOf(detectOutput()).toEqualTypeOf<OutputEnvironment>()
expectTypeOf(
  detectOutput({ env: { CI: 'true' }, stream: { isTTY: true, columns: 100 } }),
).toEqualTypeOf<OutputEnvironment>()
expectTypeOf<OutputEnvironment['agent']>().toEqualTypeOf<string | undefined>()
expectTypeOf<
  OutputEnvironment['colour' | 'live' | 'tty' | 'ci' | 'githubActions']
>().toEqualTypeOf<boolean>()
expectTypeOf<OutputEnvironment['columns']>().toEqualTypeOf<number>()
expectTypeOf<DetectOptions['ci']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<DetectOptions['colour']>().toEqualTypeOf<boolean | undefined>()
// process.stdout is an OutputStream, so is a stand-in.
const streams: readonly OutputStream[] = [process.stdout, { isTTY: false }, {}]
void streams
expectTypeOf(AGENT_VARIABLES).toEqualTypeOf<
  readonly (readonly [agent: string, variable: string])[]
>()
// @ts-expect-error CI is the caller's answer, a boolean
detectOutput({ ci: 'true' })
// @ts-expect-error the environment holds text
detectOutput({ env: { CI: true } })
// @ts-expect-error a stream says whether it is a terminal with a boolean
detectOutput({ stream: { isTTY: 'yes' } })

// A style is a set of functions from text to text.
expectTypeOf(createStyle(true)).toEqualTypeOf<Style>()
expectTypeOf(createStyle(false).red('x')).toEqualTypeOf<string>()
expectTypeOf<Style['badge']>().parameter(1).toEqualTypeOf<'green' | 'red' | 'yellow'>()
// @ts-expect-error a badge has one of three colours
createStyle(true).badge('PASS', 'blue')
