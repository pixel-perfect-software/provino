import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import {
  agentReporter,
  type ConsoleEntry,
  createStyle,
  defaultReporter,
  detectOutput,
  dotReporter,
  type Environment,
  type FailureTextBlock,
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
import type { LiveTerminal, ProvinoReporter } from '@provino/reporters/live'
import type { FileInfo, FileResult, Reporter, RunSummary, TextStyle } from '@provino/types'
import type { ProvinoChoiceOptions, ReporterChoice } from '../types.ts'
import { pinnedSink, pinnedStream } from './live-terminal.ts'
import {
  BUILT_IN_REPORTERS,
  type BuiltInReporterName,
  type DocumentReporterName,
  isBuiltInReporter,
  isDocumentReporter,
} from './reporter-names.ts'
import { UsageError } from './usage-error.ts'
import { packageVersion } from './version.ts'
import { hasViews, viewsNeedProvino, viewsOf } from './views.ts'

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
  /** `false`: the `provino` reporter draws plain symbols, not emoji (`--no-emoji`). */
  readonly emoji?: false
}

/**
 * What a dialect adds to the text reporters: its own failure text, and the summary as a reporter
 * of its own after the others (Jest's `SummaryReporter`).
 * @internal
 */
export interface TextExtras {
  /** `default`, `verbose` and `agent` print no summary: a `summary` reporter does. */
  readonly separateSummary?: true
  /** Text printed in place of Provino's failure blocks for a failed file, one block per test. */
  readonly failureText?: (file: FileResult) => readonly FailureTextBlock[] | undefined
  /** What goes under a console entry in place of its `at` line (Jest's `formatStackTrace`). */
  readonly consoleTrace?: (file: FileInfo, entry: ConsoleEntry) => string
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
  /** Jest's `--showSeed`: the summary has a `Seed:` line with this seed. */
  readonly seed?: number
  /**
   * How the run's command line asks to update snapshots (`re-run jest with \`-u\``): the `provino`
   * reporter's end card shows it when snapshots failed or are obsolete. Default: `provino run`'s.
   */
  readonly updateCommand?: string
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
  /**
   * `--tree` and `--map`: views of the `provino` reporter. They choose it when no reporter is
   * named, go to it among the ones that are, and are a usage error when it is not among them.
   */
  readonly views?: ProvinoChoiceOptions
  /** A watch run: a run that names no reporter never gets `provino` (D142). */
  readonly watch?: true
  /**
   * How many files the run will run, asked only when the answer decides the reporter (Jest's
   * single-file rule, `selectsProvino`).
   */
  readonly fileCount?: () => Promise<number>
}

/**
 * The reporters of a run, and the live terminal when the `provino` reporter draws on one: the
 * process hooks (`exit`, `resize`) and the sink the run's own stderr text goes through, so it
 * prints above the footer.
 * @internal
 */
export interface ReporterSet {
  readonly reporters: Reporter[]
  readonly terminal?: LiveTerminal
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
  return styleOf(outputFor({ ...context, stderr: context.stream }))
}

/**
 * The colours for an output decision already made, so a caller that needs `colour` and `live` too
 * decides once.
 * @internal
 */
export function styleOf(output: OutputEnvironment): Style {
  return createStyle(output.colour)
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

/**
 * The `html` reporter: D141 reserves the name for Provino's own report, which B26 Phase 5 builds.
 * A module named `html` is still reachable by its path.
 */
function htmlNotBuilt(): UsageError {
  return new UsageError(
    'html is Provino’s reserved reporter name, and its HTML report is not built yet (B26 Phase 5); for a reporter module named html, give its path, such as ./node_modules/html',
  )
}

/** The names of the reporters that write a document `documentReporter` builds today. */
type BuiltDocumentName = Exclude<DocumentReporterName, 'html'>

/** The names `builtIn` builds: every built-in that is neither a document nor Provino's own. */
type TextReporterName = Exclude<BuiltInReporterName, DocumentReporterName | 'provino'>

/**
 * One reporter choice, checked once: what `reportersFor` builds it from. Every option rule (the
 * names, the tuples, `provino`'s views) lives in `parseReporterChoice`.
 * @internal
 */
export type ParsedChoice =
  | { readonly kind: 'text'; readonly name: TextReporterName }
  | { readonly kind: 'document'; readonly name: BuiltDocumentName; readonly options: unknown }
  | { readonly kind: 'provino'; readonly options: ProvinoChoiceOptions }
  | { readonly kind: 'object'; readonly reporter: Reporter }

/**
 * The options of a `provino` reporter choice, checked: the views `tree` and `map` (each `true`, or
 * left out), nothing else.
 */
function provinoOptions(options: unknown): ProvinoChoiceOptions {
  if (options === undefined) return {}
  if (!isRecord(options)) {
    throw new UsageError('the options of the provino reporter must be an object')
  }
  let tree = false
  let map = false
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'tree' && key !== 'map') {
      throw new UsageError(`the provino reporter has no "${key}" option (it takes tree and map)`)
    }
    if (value === undefined) continue
    if (value !== true) {
      throw new UsageError(`the "${key}" option of the provino reporter must be true`)
    }
    if (key === 'tree') tree = true
    else map = true
  }
  return viewsOf(tree, map)
}

function isDocumentName(name: string): name is BuiltDocumentName {
  return name !== 'html' && isDocumentReporter(name)
}

/**
 * Checks one reporter choice and says what it is: a built-in by name, a document reporter with its
 * options, `provino` with its options, or a reporter object. `html` and anything else is a
 * `UsageError`.
 * @internal
 */
export function parseReporterChoice(choice: unknown): ParsedChoice {
  if (typeof choice === 'string' && isBuiltInReporter(choice)) {
    if (choice === 'html') throw htmlNotBuilt()
    if (choice === 'provino') return { kind: 'provino', options: {} }
    if (isDocumentName(choice)) return { kind: 'document', name: choice, options: undefined }
    // What is left of the built-in names after the three cases above.
    const name: TextReporterName = choice
    return { kind: 'text', name }
  }
  if (Array.isArray(choice)) {
    const [name, options, ...rest]: unknown[] = choice
    if (rest.length === 0 && name === 'html') throw htmlNotBuilt()
    if (rest.length === 0 && name === 'provino') {
      return { kind: 'provino', options: provinoOptions(options) }
    }
    if (rest.length === 0 && typeof name === 'string' && isDocumentName(name)) {
      return { kind: 'document', name, options }
    }
  } else if (isReporter(choice)) {
    return { kind: 'object', reporter: choice }
  }
  throw new UsageError(
    `unknown reporter ${describeChoice(choice)}; use ${BUILT_IN_REPORTERS.map((name) => JSON.stringify(name)).join(', ')}, ["json", { outputFile }], ["junit", { outputFile }], ["provino", {}] or a reporter object`,
  )
}

/**
 * The `ReporterChoice` a dialect's host step names (`provino jest`'s `reporters: ['provino']`),
 * checked by the one parser.
 * @internal
 */
export function hostReporterChoice(
  name: string,
  options: Readonly<Record<string, unknown>>,
): ReporterChoice {
  const parsed = parseReporterChoice([name, options])
  if (parsed.kind !== 'provino') throw new UsageError(`unknown host reporter "${name}"`)
  return Object.keys(parsed.options).length === 0 ? 'provino' : ['provino', parsed.options]
}

/** The reporter `name` names, writing its document where `options` say: `{ outputFile }`, or stdout without one. */
function documentReporter(
  name: BuiltDocumentName,
  context: ReporterContext,
  options: unknown,
): Built {
  if (options !== undefined && !isRecord(options)) {
    throw new UsageError(`the options of the ${name} reporter must be an object`)
  }
  const given = options ?? {}
  const path = documentPath(name, context, given)
  const { project } = context
  // The stdout's own `write`, taken now: while a live footer routes the process's other stdout
  // writes above it, the document still goes where it was asked to.
  const target = path === undefined ? { stream: pinnedSink(context.stdout) } : { outputFile: path }
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

/**
 * Where the text reporters write and what they are told of the terminal: stderr as detected, or,
 * beside a live `provino` reporter, its `passthrough` with no live block, so one region redraws.
 */
interface TextTarget {
  readonly stream: TextSink
  readonly output: OutputEnvironment
}

/** The text reporters' options: where the run is shown, in what colour, and what it leaves out. */
function textOptions(context: ReporterContext, target: TextTarget): TextReporterOptions {
  const { display } = context
  const { output } = target
  return {
    stream: target.stream,
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
    ...(context.text?.consoleTrace === undefined
      ? {}
      : { consoleTrace: context.text.consoleTrace }),
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
    ...(context.text?.seed === undefined ? {} : { seed: context.text.seed }),
  }
}

function text(reporter: Reporter): Built {
  return { reporter }
}

/** A built-in text reporter by name. No `default` arm: a name the list gains without one here fails to compile. */
function builtIn(name: TextReporterName, context: ReporterContext, target: TextTarget): Built {
  switch (name) {
    case 'default':
      return text(defaultReporter(textOptions(context, target)))
    case 'verbose':
      return text(verboseReporter(textOptions(context, target)))
    case 'dot':
      return text(dotReporter(textOptions(context, target)))
    case 'agent':
      return text(agentReporter(textOptions(context, target)))
    case 'summary':
      return text(summaryReporter(textOptions(context, target)))
    case 'github-actions': {
      const workspace = context.env.GITHUB_WORKSPACE
      return text(
        githubActionsReporter({
          stream: target.stream,
          report: context.project.policy.report,
          ...(workspace === undefined || workspace === '' ? {} : { workspace }),
        }),
      )
    }
  }
}

/** Builds a checked choice; `provino` is built by `reportersFor` itself. */
function reporterFor(choice: ParsedChoice, context: ReporterContext, target: TextTarget): Built {
  switch (choice.kind) {
    case 'text':
      return builtIn(choice.name, context, target)
    case 'document':
      return documentReporter(choice.name, context, choice.options)
    case 'object':
      return text(choice.reporter)
    case 'provino':
      throw new Error('the provino reporter is built by reportersFor')
  }
}

/**
 * How `--update` is asked for on `provino run` (the end card's hint); a dialect's command line
 * gives its own words in `TextExtras.updateCommand`.
 */
const RUN_UPDATE_COMMAND = 're-run with `-u`'

/**
 * The `provino` reporter (B26), loaded by dynamic import only now that it is chosen, so a run
 * without it loads none of its code (performance rule 5, speed). Its glyphs and hyperlinks are
 * decided from the run's environment, once. It writes with stderr's own methods, taken now, so the
 * live region can route the process's other writes through it (`hookTerminal`).
 */
async function provinoFor(
  context: ReporterContext,
  output: OutputEnvironment,
  views: ProvinoChoiceOptions,
): Promise<ProvinoReporter> {
  const live = await import('@provino/reporters/live')
  const { display, env } = context
  const set = live.detectGlyphs({
    env,
    platform: process.platform,
    ...(display?.emoji === false ? { emoji: false } : {}),
  })
  return live.provinoReporter({
    stream: pinnedStream(context.stderr),
    live: output.live,
    colour: output.colour,
    columns: output.columns,
    glyphs: live.GLYPHS[set],
    hyperlinks: live.detectHyperlinks({ env, tty: output.tty, ci: context.project.config.ci }),
    cwd: context.cwd,
    snapshotHint: context.text?.updateCommand ?? RUN_UPDATE_COMMAND,
    ...(context.text?.seed === undefined ? {} : { seed: context.text.seed }),
    ...(display?.silent === true ? { silent: true } : {}),
    ...(display?.noStackTrace === true ? { noStackTrace: true } : {}),
    ...(hasViews(views) ? { views } : {}),
  })
}

/**
 * Whether a run lists each test of its one file (Jest's single-file rule, `runJest`): the
 * policy's `report.listTestsForSingleFile`, exactly one file, not `--silent`, and `verbose` not
 * turned off on purpose.
 * @internal
 */
export function listsSingleFile(input: {
  readonly listTestsForSingleFile: boolean
  readonly files: number
  readonly silent: boolean
  readonly verboseOff: boolean
}): boolean {
  return input.listTestsForSingleFile && input.files === 1 && !input.silent && !input.verboseOff
}

/**
 * The one rule for when a run that names no reporter gets the `provino` reporter (D135): an
 * interactive terminal (`detectOutput`'s `live`), not watch mode (D142), not verbose (D143: the
 * config's `verbose`, a project's, `--verbose`), and not a run that lists its one file's tests (Jest's
 * single-file rule, the same listing `verbose` gives). `provino run` (`implicitChoices`) and
 * `provino jest` (`setUpJestReporters`) both ask it. `files` is asked only when the rest holds, so a
 * run that can't get `provino` counts nothing.
 * @internal
 */
export async function selectsProvino(input: {
  readonly live: boolean
  readonly watch: boolean
  readonly verbose: boolean
  readonly singleFile: {
    readonly listTestsForSingleFile: boolean
    readonly silent: boolean
    readonly verboseOff: boolean
    /** The files the run will run; `undefined` when the caller can't tell before the run. */
    readonly files: (() => Promise<number>) | undefined
  }
}): Promise<boolean> {
  if (!input.live || input.watch || input.verbose) return false
  const { singleFile } = input
  if (!singleFile.listTestsForSingleFile || singleFile.files === undefined) return true
  const files = await singleFile.files()
  return !listsSingleFile({ ...singleFile, files })
}

/**
 * The reporters of a run when none are named: the policy's `report.defaultReporters`, with
 * `default` replaced by `provino` when `selectsProvino` says so (D135) or views ask for it
 * (`--tree`, `--map`: an explicit ask, wherever the run is), else by `agent` when an agent runs the
 * process (and by `verbose` under `--verbose`), and `github-actions` added on GitHub Actions (not
 * beside a `provino` the terminal chose: a live terminal is not CI; beside one the views chose it
 * is, so a run's annotations are not lost).
 */
async function implicitChoices(
  context: ReporterContext,
  output: OutputEnvironment,
): Promise<readonly unknown[]> {
  const { display } = context
  const asked = hasViews(context.views ?? {})
  const provino =
    asked ||
    (await selectsProvino({
      live: output.live,
      watch: context.watch === true,
      verbose: display?.verbose === true,
      singleFile: {
        listTestsForSingleFile: context.project.policy.report.listTestsForSingleFile,
        silent: display?.silent === true,
        verboseOff: display?.verbose === false,
        files: context.fileCount,
      },
    }))
  if (provino) {
    const chosen = context.project.policy.report.defaultReporters.map((name) =>
      name === 'default' ? 'provino' : name,
    )
    return asked && output.githubActions && !chosen.includes('github-actions')
      ? [...chosen, 'github-actions']
      : chosen
  }
  const named = context.project.policy.report.defaultReporters.map((name) => {
    if (name !== 'default') return name
    if (output.agent !== undefined) return 'agent'
    return display?.verbose === true ? 'verbose' : name
  })
  return output.githubActions && !named.includes('github-actions')
    ? [...named, 'github-actions']
    : named
}

/**
 * The reporters for a run: `choices`, else the policy's `report.defaultReporters` (each a
 * built-in name) as the environment reshapes them (`implicitChoices`). Each choice is checked
 * once (`parseReporterChoice`); one that is none of the built-ins, an options tuple or a reporter
 * object is a `UsageError`. With a `provino` reporter on a live terminal, the other text reporters
 * write through its `passthrough` with no live block of their own, and its `LiveTerminal` comes
 * back for the caller's process hooks. A throw after the reporter exists restores its terminal.
 * @internal
 */
export async function reportersFor(
  choices: readonly unknown[] | undefined,
  context: ReporterContext,
): Promise<ReporterSet> {
  if (choices !== undefined && !Array.isArray(choices)) {
    throw new UsageError('the reporters option must be an array')
  }
  const output = detectOutput({
    env: context.env,
    stream: outputStreamOf(context.stderr),
    ci: context.project.config.ci,
    ...(context.display?.colour === undefined ? {} : { colour: context.display.colour }),
  })
  const parsed = (choices ?? (await implicitChoices(context, output))).map(parseReporterChoice)
  const provinoAt = parsed.flatMap((choice, index) => (choice.kind === 'provino' ? [index] : []))
  if (provinoAt.length > 1) throw new UsageError('the provino reporter is named more than once')
  const at = provinoAt[0]
  const chosen = at === undefined ? undefined : parsed[at]
  const views = context.views ?? {}
  // The views are the options of the one `provino` choice, from wherever it came: merged here, once.
  if (hasViews(views) && chosen?.kind !== 'provino') throw viewsNeedProvino(views)
  const provino =
    chosen?.kind === 'provino'
      ? await provinoFor(context, output, { ...chosen.options, ...views })
      : undefined
  try {
    const drawing = provino !== undefined && output.live
    const target: TextTarget = drawing
      ? { stream: provino.terminal.passthrough, output: { ...output, live: false } }
      : { stream: context.stderr, output }
    const built = parsed.map((choice, index) =>
      index === at && provino !== undefined ? text(provino) : reporterFor(choice, context, target),
    )
    if (built.filter((entry) => entry.writes === 'stdout').length > 1) {
      throw new UsageError(
        'two reporters would both write to stdout; give each an outputFile (json, normalized-json and junit write there without one)',
      )
    }
    // Last, so it sees every other reporter's failure (the bus tells the reporters after a failing
    // one about it before they get the same event) before it writes its document.
    const reporters = built
      .toSorted((a, b) => Number(a.writes !== undefined) - Number(b.writes !== undefined))
      .map((entry) => entry.reporter)
    return drawing ? { reporters, terminal: provino.terminal } : { reporters }
  } catch (error) {
    // Nothing is drawn before `run:start`, but the terminal is the reporter's from here on.
    provino?.terminal.restore()
    throw error
  }
}
