import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import {
  agentReporter,
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
  type TextReporterOptions,
  type TextSink,
  verboseReporter,
} from '@provino/reporters'
import type { Reporter } from '@provino/types'
import { UsageError } from './usage-error.ts'
import { packageVersion } from './version.ts'

/**
 * The reporters `run()` and the command line can name. A new one goes here, in `reporterFor`'s
 * switch (which the compiler holds to this list) and in `ReporterChoice`.
 * @internal
 */
export const BUILT_IN_REPORTERS = [
  'default',
  'verbose',
  'dot',
  'agent',
  'json',
  'normalized-json',
  'junit',
  'github-actions',
] as const

/**
 * A built-in reporter's name.
 * @internal
 */
export type BuiltInReporterName = (typeof BUILT_IN_REPORTERS)[number]

/**
 * The reporters that write a document, to a file or to stdout: they go last, so each sees every
 * other reporter's failure before it writes.
 * @internal
 */
export const DOCUMENT_REPORTERS = ['json', 'normalized-json', 'junit'] as const

/**
 * The name of a reporter that writes a document.
 * @internal
 */
export type DocumentReporterName = (typeof DOCUMENT_REPORTERS)[number]

/**
 * Whether `name` is a built-in reporter.
 * @internal
 */
export function isBuiltInReporter(name: string): name is BuiltInReporterName {
  return BUILT_IN_REPORTERS.some((known) => known === name)
}

/**
 * Whether `name` is a reporter that writes a document.
 * @internal
 */
export function isDocumentReporter(name: string): name is DocumentReporterName {
  return DOCUMENT_REPORTERS.some((known) => known === name)
}

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
  /** It writes a document (`DOCUMENT_REPORTERS`). */
  readonly document: boolean
  /** It writes that document to stdout rather than to a file. */
  readonly toStdout: boolean
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The stream as the reporters' detection reads it: whether it is a terminal, and how wide. */
function outputStreamOf(stream: NodeJS.WritableStream): OutputStream {
  const isTTY: unknown = Reflect.get(stream, 'isTTY')
  const columns: unknown = Reflect.get(stream, 'columns')
  return {
    ...(typeof isTTY === 'boolean' ? { isTTY } : {}),
    ...(typeof columns === 'number' ? { columns } : {}),
  }
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

function jsonDocument(
  reporter: 'json' | 'normalized-json',
  context: ReporterContext,
  options: unknown,
): Built {
  if (options !== undefined && !isRecord(options)) {
    throw new UsageError(`the options of the ${reporter} reporter must be an object`)
  }
  const given = options ?? {}
  const path = documentPath(reporter, context, given)
  const suite = optionalString(reporter, given, 'suite')
  const { project } = context
  const make = reporter === 'json' ? jsonReporter : normalizedJsonReporter
  return {
    reporter: make({
      ...(path === undefined ? { stream: context.stdout } : { outputFile: path }),
      suite: suite ?? basename(project.rootDir),
      runner: `provino:${project.dialect?.name ?? 'neutral'}`,
      // Read here, as only this reporter needs it.
      runnerVersion: packageVersion(),
      // The run's own answer, so `env.ci` in the file is what the run used.
      ci: project.config.ci,
      // The policy that decides the exit code, so the file's `success` agrees with it.
      unhandledErrors: project.policy.orchestrator.unhandledErrors,
    }),
    document: true,
    toStdout: path === undefined,
  }
}

function junitDocument(context: ReporterContext, options: unknown): Built {
  if (options !== undefined && !isRecord(options)) {
    throw new UsageError('the options of the junit reporter must be an object')
  }
  const given = options ?? {}
  const path = documentPath('junit', context, given)
  const name = optionalString('junit', given, 'name')
  return {
    reporter: junitReporter({
      report: context.project.policy.report,
      ...(path === undefined ? { stream: context.stdout } : { outputFile: path }),
      ...(name === undefined ? {} : { name }),
    }),
    document: true,
    toStdout: path === undefined,
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
  }
}

function text(reporter: Reporter): Built {
  return { reporter, document: false, toStdout: false }
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
      return jsonDocument(name, context, undefined)
    case 'junit':
      return junitDocument(context, undefined)
  }
}

function reporterFor(choice: unknown, context: ReporterContext, output: OutputEnvironment): Built {
  if (typeof choice === 'string') {
    if (isBuiltInReporter(choice)) return builtIn(choice, context, output)
  } else if (Array.isArray(choice)) {
    const [name, options, ...rest]: unknown[] = choice
    if (rest.length === 0) {
      if (name === 'json' || name === 'normalized-json') return jsonDocument(name, context, options)
      if (name === 'junit') return junitDocument(context, options)
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
  if (built.filter((entry) => entry.toStdout).length > 1) {
    throw new UsageError(
      'two reporters would both write to stdout; give each an outputFile (json, normalized-json and junit write there without one)',
    )
  }
  // Last, so it sees every other reporter's failure (the bus tells the reporters after a failing
  // one about it before they get the same event) before it writes its document.
  return built
    .toSorted((a, b) => Number(a.document) - Number(b.document))
    .map((entry) => entry.reporter)
}
