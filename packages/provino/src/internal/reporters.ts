import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import {
  agentReporter,
  createStyle,
  defaultReporter,
  detectOutput,
  dotReporter,
  type Environment,
  githubActionsReporter,
  jsonReporter,
  junitReporter,
  normalizedJsonReporter,
  type OutputEnvironment,
  type OutputStream,
  type Style,
  summaryReporter,
  type TextReporterOptions,
  type TextSink,
  verboseReporter,
} from '@provino/reporters'
import type { FileResult, Reporter, RunSummary, TextStyle } from '@provino/types'
import {
  BUILT_IN_REPORTERS,
  type BuiltInReporterName,
  type DocumentReporterName,
  isBuiltInReporter,
  isDocumentReporter,
} from './reporter-names.ts'
import { UsageError } from './usage-error.ts'
import { packageVersion } from './version.ts'

/**
 * What a command line or a config says about how text looks, whatever dialect it came from: Jest's
 * `--verbose`, `--silent`, `--expand`, `--noStackTrace` and `--colors`.
 * @internal
 */
export interface DisplayOptions {
  /**
   * `true`: list every test (`verbose` in place of `default`). `false`: Jest's `verbose: false`,
   * set on purpose, which also turns off the dialect's one-file listing. Unset: neither.
   */
  readonly verbose?: boolean
  /** Print none of the tests' console output (which also turns off the one-file listing). */
  readonly silent?: boolean
  /** `verbose` lists skipped and todo tests in declaration order. */
  readonly expand?: boolean
  /** Leave the stack frames out of the failure messages. */
  readonly noStackTrace?: boolean
  /** Colour on or off, whatever the environment says. */
  readonly colour?: boolean
}

/**
 * What a dialect adds to the text reporters: its own failure text, and the summary as a reporter
 * of its own after the others (Jest's `SummaryReporter`).
 * @internal
 */
export interface TextExtras {
  /** `default`, `verbose` and `agent` print no summary: a `summary` reporter does. */
  readonly separateSummary?: true
  /** Text printed in place of Provino's failure blocks for a failed file. */
  readonly failureText?: (file: FileResult) => string | undefined
  /** Lines under a file's output (Jest's per-file snapshot lines). */
  readonly fileNotes?: (file: FileResult, style: TextStyle) => readonly string[] | undefined
  /** The `summary` reporter's: reprint the failures when more suites than this ran. */
  readonly failureSummaryThreshold?: number
  readonly snapshotSummary?: (
    summary: RunSummary,
    style: TextStyle,
  ) => readonly string[] | undefined
  readonly closingLine?: (summary: RunSummary, style: TextStyle) => string | undefined
  /** The totals always have a `Snapshots:` line. */
  readonly snapshotsAlways?: true
}

/**
 * What the built-in reporters are made from.
 * @internal
 */
export interface ReporterContext {
  readonly project: ResolvedProject
  /** `outputFile` is relative to this. */
  readonly cwd: string
  readonly stdout: TextSink
  readonly stderr: NodeJS.WritableStream
  /** What the run reads for the terminal, CI, an agent and colour: resolved by the caller. */
  readonly env: Environment
  readonly display?: DisplayOptions
  readonly text?: TextExtras
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReporter(value: unknown): value is Reporter {
  return isRecord(value) && typeof value.name === 'string'
}

function describeChoice(choice: unknown): string {
  return typeof choice === 'string' ? JSON.stringify(choice) : typeof choice
}

/** An optional string option; anything else is a usage error naming the option. */
function optionalString(
  reporter: string,
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = options[key]
  if (value === undefined || typeof value === 'string') return value
  throw new UsageError(`the "${key}" option of the ${reporter} reporter must be a string`)
}

/** A reporter, and what `reportersFor` needs to know about it to order and check the set. */
interface Built {
  readonly reporter: Reporter
  /** A document reporter (`DOCUMENT_REPORTERS`): where it writes. Other reporters write none. */
  readonly writes?: 'stdout' | 'file'
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The stream as the reporters' detection reads it: whether it is a terminal, and how wide. */
function outputStreamOf(stream: object): OutputStream {
  const isTTY: unknown = Reflect.get(stream, 'isTTY')
  const columns: unknown = Reflect.get(stream, 'columns')
  return {
    ...(typeof isTTY === 'boolean' ? { isTTY } : {}),
    ...(typeof columns === 'number' ? { columns } : {}),
  }
}

/**
 * The colours for text written outside a reporter (`--collectTests`' tree): on when `detectOutput`
 * says the output is coloured, from the same stream and environment the reporters read.
 * @internal
 */
export function styleFor(context: {
  readonly env: Environment
  /** The stream whose terminal decides the colour: Jest's chalk reads stdout's. */
  readonly stream: object
  readonly ci: boolean
  readonly colour?: boolean | undefined
}): Style {
  return createStyle(outputFor({ ...context, stderr: context.stream }).colour)
}

/**
 * What the run's output looks like to the reporters (a terminal, CI, an agent, colour): the one
 * `detectOutput` answer from the stream and environment.
 * @internal
 */
export function outputFor(context: {
  readonly env: Environment
  readonly stderr: object
  readonly ci: boolean
  readonly colour?: boolean | undefined
}): OutputEnvironment {
  return detectOutput({
    env: context.env,
    stream: outputStreamOf(context.stderr),
    ci: context.ci,
    ...(context.colour === undefined ? {} : { colour: context.colour }),
  })
}

/** Where a document reporter's `outputFile` is, checked now so a path that can never be written doesn't cost a whole run. */
function documentPath(
  reporter: string,
  context: ReporterContext,
  options: Readonly<Record<string, unknown>>,
): string | undefined {
  const outputFile = optionalString(reporter, options, 'outputFile')
  if (outputFile === '') {
    throw new UsageError(`the "outputFile" option of the ${reporter} reporter is empty`)
  }
  const path = outputFile === undefined ? undefined : resolve(context.cwd, outputFile)
  if (path !== undefined && isDirectory(path)) {
    throw new UsageError(
      `the outputFile "${outputFile}" of the ${reporter} reporter is a directory`,
    )
  }
  return path
}

/** The reporter `name` names, writing its document where `options` say: `{ outputFile }`, or stdout without one. */
function documentReporter(
  name: DocumentReporterName,
  context: ReporterContext,
  options: unknown,
): Built {
  if (options !== undefined && !isRecord(options)) {
    throw new UsageError(`the options of the ${name} reporter must be an object`)
  }
  const given = options ?? {}
  const path = documentPath(name, context, given)
  const { project } = context
  const target = path === undefined ? { stream: context.stdout } : { outputFile: path }
  const writes = path === undefined ? 'stdout' : 'file'
  if (name === 'junit') {
    const title = optionalString(name, given, 'name')
    return {
      reporter: junitReporter({
        report: project.policy.report,
        ...target,
        ...(title === undefined ? {} : { name: title }),
      }),
      writes,
    }
  }
  const make = name === 'json' ? jsonReporter : normalizedJsonReporter
  return {
    reporter: make({
      ...target,
      suite: optionalString(name, given, 'suite') ?? basename(project.rootDir),
      runner: `provino:${project.dialect?.name ?? 'neutral'}`,
      // Read here, as only this reporter needs it.
      runnerVersion: packageVersion(),
      // The run's own answer, so `env.ci` in the file is what the run used.
      ci: project.config.ci,
      // The policy that decides the exit code, so the file's `success` agrees with it.
      unhandledErrors: project.policy.orchestrator.unhandledErrors,
    }),
    writes,
  }
}

/** The text reporters' options: where the run is shown, in what colour, and what it leaves out. */
function textOptions(context: ReporterContext, output: OutputEnvironment): TextReporterOptions {
  const { display } = context
  return {
    stream: context.stderr,
    report: context.project.policy.report,
    colour: output.colour,
    live: output.live,
    columns: output.columns,
    ...(display?.silent === true ? { silent: true } : {}),
    ...(display?.noStackTrace === true ? { noStackTrace: true } : {}),
    ...(display?.expand === true ? { expand: true } : {}),
    ...(display?.verbose === false ? { verbose: false as const } : {}),
    ...(display?.verbose === true ? { verboseRun: true as const } : {}),
    ...(context.text?.separateSummary === true ? { summary: false as const } : {}),
    ...(context.text?.fileNotes === undefined ? {} : { fileNotes: context.text.fileNotes }),
    ...(context.text?.failureText === undefined ? {} : { failureText: context.text.failureText }),
    ...(context.text?.failureSummaryThreshold === undefined
      ? {}
      : { failureSummaryThreshold: context.text.failureSummaryThreshold }),
    ...(context.text?.snapshotSummary === undefined
      ? {}
      : { snapshotSummary: context.text.snapshotSummary }),
    ...(context.text?.closingLine === undefined ? {} : { closingLine: context.text.closingLine }),
    ...(context.text?.snapshotsAlways === true ? { snapshotsAlways: true as const } : {}),
  }
}

function text(reporter: Reporter): Built {
  return { reporter }
}

/** A built-in reporter by name. No `default` arm: a name `BUILT_IN_REPORTERS` gains without one here fails to compile. */
function builtIn(
  name: BuiltInReporterName,
  context: ReporterContext,
  output: OutputEnvironment,
): Built {
  switch (name) {
    case 'default':
      return text(defaultReporter(textOptions(context, output)))
    case 'verbose':
      return text(verboseReporter(textOptions(context, output)))
    case 'dot':
      return text(dotReporter(textOptions(context, output)))
    case 'agent':
      return text(agentReporter(textOptions(context, output)))
    case 'summary':
      return text(summaryReporter(textOptions(context, output)))
    case 'github-actions': {
      const workspace = context.env.GITHUB_WORKSPACE
      return text(
        githubActionsReporter({
          stream: context.stderr,
          report: context.project.policy.report,
          ...(workspace === undefined || workspace === '' ? {} : { workspace }),
        }),
      )
    }
    case 'json':
    case 'normalized-json':
    case 'junit':
      return documentReporter(name, context, undefined)
  }
}

function reporterFor(choice: unknown, context: ReporterContext, output: OutputEnvironment): Built {
  if (typeof choice === 'string') {
    if (isBuiltInReporter(choice)) return builtIn(choice, context, output)
  } else if (Array.isArray(choice)) {
    const [name, options, ...rest]: unknown[] = choice
    if (rest.length === 0 && typeof name === 'string' && isDocumentReporter(name)) {
      return documentReporter(name, context, options)
    }
  } else if (isReporter(choice)) {
    return text(choice)
  }
  throw new UsageError(
    `unknown reporter ${describeChoice(choice)}; use ${BUILT_IN_REPORTERS.map((name) => JSON.stringify(name)).join(', ')}, ["json", { outputFile }], ["junit", { outputFile }] or a reporter object`,
  )
}

/**
 * The reporters of a run when none are named: the policy's `report.defaultReporters`, with
 * `default` replaced by `agent` when an agent runs the process (and by `verbose` under
 * `--verbose`), and `github-actions` added on GitHub Actions.
 */
function implicitChoices(context: ReporterContext, output: OutputEnvironment): readonly unknown[] {
  const named = context.project.policy.report.defaultReporters.map((name) => {
    if (name !== 'default') return name
    if (output.agent !== undefined) return 'agent'
    return context.display?.verbose === true ? 'verbose' : name
  })
  return output.githubActions && !named.includes('github-actions')
    ? [...named, 'github-actions']
    : named
}

/**
 * The reporters for a run: `choices`, else the policy's `report.defaultReporters` (each a
 * built-in name) as the environment reshapes them (`implicitChoices`). A choice that is none of
 * the built-ins, an options tuple or a reporter object is a `UsageError`.
 * @internal
 */
export function reportersFor(
  choices: readonly unknown[] | undefined,
  context: ReporterContext,
): Reporter[] {
  if (choices !== undefined && !Array.isArray(choices)) {
    throw new UsageError('the reporters option must be an array')
  }
  const output = detectOutput({
    env: context.env,
    stream: outputStreamOf(context.stderr),
    ci: context.project.config.ci,
    ...(context.display?.colour === undefined ? {} : { colour: context.display.colour }),
  })
  const built = (choices ?? implicitChoices(context, output)).map((choice) =>
    reporterFor(choice, context, output),
  )
  if (built.filter((entry) => entry.writes === 'stdout').length > 1) {
    throw new UsageError(
      'two reporters would both write to stdout; give each an outputFile (json, normalized-json and junit write there without one)',
    )
  }
  // Last, so it sees every other reporter's failure (the bus tells the reporters after a failing
  // one about it before they get the same event) before it writes its document.
  return built
    .toSorted((a, b) => Number(a.writes !== undefined) - Number(b.writes !== undefined))
    .map((entry) => entry.reporter)
}
