// The public API of provino/node.
import type { PoolKind, Reporter, RunSummary } from '@provino/types'
import { expectTypeOf } from 'expect-type'
import {
  type HtmlChoiceOptions,
  type JUnitChoiceOptions,
  type NormalizedJsonChoiceOptions,
  type ProvinoChoiceOptions,
  type ReporterChoice,
  type RunOptions,
  type RunResult,
  run,
} from 'provino/node'

// The entry exports `run` and nothing else as a value.
expectTypeOf<keyof typeof import('provino/node')>().toEqualTypeOf<'run'>()
expectTypeOf(run).toEqualTypeOf<(options: RunOptions) => Promise<RunResult>>()

// The result: an exit code, and the summary unless the run never started.
expectTypeOf<RunResult['exitCode']>().toEqualTypeOf<number>()
expectTypeOf<RunResult['summary']>().toEqualTypeOf<RunSummary | null>()

// The options.
expectTypeOf<RunOptions['config']>().toEqualTypeOf<string>()
expectTypeOf<RunOptions['pool']>().toEqualTypeOf<PoolKind | undefined>()
expectTypeOf<RunOptions['maxWorkers']>().toEqualTypeOf<number | undefined>()
expectTypeOf<RunOptions['reporters']>().toEqualTypeOf<readonly ReporterChoice[] | undefined>()
expectTypeOf<RunOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>()
expectTypeOf<RunOptions['stderr']>().toEqualTypeOf<NodeJS.WritableStream | undefined>()
expectTypeOf<RunOptions['stdout']>().toEqualTypeOf<{ write(chunk: string): unknown } | undefined>()

// What a reporter choice can be.
expectTypeOf<'default'>().toExtend<ReporterChoice>()
expectTypeOf<'normalized-json'>().toExtend<ReporterChoice>()
expectTypeOf<readonly ['normalized-json', NormalizedJsonChoiceOptions]>().toExtend<ReporterChoice>()
expectTypeOf<Reporter>().toExtend<ReporterChoice>()
for (const name of [
  'verbose',
  'dot',
  'agent',
  'github-actions',
  'summary',
  'json',
  'junit',
] as const) {
  expectTypeOf(name).toExtend<ReporterChoice>()
}
expectTypeOf<readonly ['json', NormalizedJsonChoiceOptions]>().toExtend<ReporterChoice>()
expectTypeOf<readonly ['junit', JUnitChoiceOptions]>().toExtend<ReporterChoice>()
// B26: the provino reporter (D135) and the reserved html one (D141).
expectTypeOf<'provino'>().toExtend<ReporterChoice>()
expectTypeOf<'html'>().toExtend<ReporterChoice>()
expectTypeOf<readonly ['provino', ProvinoChoiceOptions]>().toExtend<ReporterChoice>()
expectTypeOf<readonly ['html', HtmlChoiceOptions]>().toExtend<ReporterChoice>()
expectTypeOf<ProvinoChoiceOptions>().toEqualTypeOf<{
  readonly tree?: true
  readonly map?: true
}>()
expectTypeOf<HtmlChoiceOptions>().toEqualTypeOf<{ readonly outputFile?: string }>()
expectTypeOf<RunOptions['emoji']>().toEqualTypeOf<false | undefined>()
expectTypeOf<JUnitChoiceOptions>().toEqualTypeOf<{
  readonly outputFile?: string
  readonly name?: string
}>()
expectTypeOf<RunOptions['env']>().toEqualTypeOf<
  Readonly<Record<string, string | undefined>> | undefined
>()
expectTypeOf<NormalizedJsonChoiceOptions>().toEqualTypeOf<{
  readonly outputFile?: string
  readonly suite?: string
}>()

// Valid calls.
void run({ config: 'provino.config.mjs' })
void run({
  config: 'provino.config.mjs',
  cwd: '/project',
  maxWorkers: 2,
  pool: 'threads',
  reporters: [
    'default',
    ['normalized-json', { outputFile: 'out.json', suite: 'app' }],
    ['junit', { outputFile: 'junit.xml', name: 'app' }],
    'dot',
    { name: 'mine', 'run:end': () => {} },
  ],
  env: { CI: 'true', FORCE_COLOR: undefined },
  ci: true,
  passWithNoTests: true,
  testNamePattern: 'adds',
  cache: false,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: AbortSignal.abort(),
})

// Misuse.
// @ts-expect-error config is required
void run({})
// @ts-expect-error config is a path, not a number
void run({ config: 1 })
// @ts-expect-error there is no pool called cluster
void run({ config: 'c.mjs', pool: 'cluster' })
// @ts-expect-error "tap" is not a built-in reporter
void run({ config: 'c.mjs', reporters: ['tap'] })
// @ts-expect-error the junit reporter has no suite option
void run({ config: 'c.mjs', reporters: [['junit', { suite: 'app' }]] })
// @ts-expect-error the junit output file is a string
void run({ config: 'c.mjs', reporters: [['junit', { outputFile: 1 }]] })
// @ts-expect-error the environment holds text
void run({ config: 'c.mjs', env: { CI: true } })
// @ts-expect-error outputFile is a string
void run({ config: 'c.mjs', reporters: [['normalized-json', { outputFile: 1 }]] })
// @ts-expect-error the options tuple belongs to normalized-json only
void run({ config: 'c.mjs', reporters: [['default', { outputFile: 'out.json' }]] })
// @ts-expect-error normalized-json has no such option
void run({ config: 'c.mjs', reporters: [['normalized-json', { pretty: true }]] })
// @ts-expect-error the provino reporter has no emoji option (it is RunOptions.emoji)
void run({ config: 'c.mjs', reporters: [['provino', { emoji: 'no' }]] })
// @ts-expect-error a view is turned on with true, never off
void run({ config: 'c.mjs', reporters: [['provino', { tree: false }]] })
// @ts-expect-error the html output file is a string
void run({ config: 'c.mjs', reporters: [['html', { outputFile: 1 }]] })
// @ts-expect-error emoji is only turned off
void run({ config: 'c.mjs', emoji: true })
// @ts-expect-error maxWorkers is a number
void run({ config: 'c.mjs', maxWorkers: '2' })
// @ts-expect-error cache is a boolean
void run({ config: 'c.mjs', cache: 'no' })
// @ts-expect-error ci is a boolean
void run({ config: 'c.mjs', ci: 'yes' })
// @ts-expect-error stderr is a writable stream
void run({ config: 'c.mjs', stderr: 'out.log' })
// @ts-expect-error a signal is an AbortSignal
void run({ config: 'c.mjs', signal: 1 })
// @ts-expect-error an unknown option
void run({ config: 'c.mjs', workers: 2 })
