// `provino vitest <vitest arguments>` (T11.16, B25g): the Vitest command line, parsed by the Vitest
// dialect's own parser (a rebuild of cac's grammar), layered over the projects the Vitest config
// reader finds, run by the same coordinator as `provino run`, and ended with Vitest's exit codes.
// It runs once, as `vitest run` does: `watch` and `--watch` are refused (D175).

import { mkdir, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, resolve } from 'node:path'
import { type ResolvedProject, resolveNeutralProject } from '@provino/config'
import {
  readVitestConfig,
  VitestCliError,
  VitestConfigError,
  vitestArgvToTestConfig,
  vitestCli,
  vitestNodeDialect,
} from '@provino/dialect-vitest/node'
import { createVitestResults } from '@provino/dialect-vitest/results'
import type { ShardSpec } from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { Diagnostic, FileFilter, NeutralProject } from '@provino/types'
import type { ReporterChoice } from '../types.ts'
import { ENVIRONMENTS } from './built-ins.ts'
import { usageMessage } from './describe.ts'
import { type ExecuteOptions, executeProject } from './execute.ts'

/**
 * Where the command reads and writes.
 * @internal
 */
export interface VitestCommandIo {
  readonly stdout: TextSink
  readonly stderr: NodeJS.WritableStream
  readonly cwd: string
  /** Reporters in place of the ones the command line and the config name (a test's collector). */
  readonly reporters?: readonly ReporterChoice[]
  /** What the reporters read for the terminal, CI, an agent and colour. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Aborted by the first SIGINT or SIGTERM: the run ends 130 or 143. */
  readonly signal?: AbortSignal
  /** Aborted by the second signal: every worker is killed at once. */
  readonly forceSignal?: AbortSignal
}

/** Every error Vitest's CLI ends on is exit code 1 (`process.exitCode = 1`, cli-api.ts; `cli/unknown-flag`). */
const VITEST_ERROR_EXIT = 1

/**
 * The variables Vitest's CLI sets before it reads a config (`prepareVitest`, cli-api.ts L234-L236),
 * and the one its pool gives every worker (`VITEST_MODE`, pool.ts L259; a run is `RUN`, D175).
 * Set on this process, so a config, a global setup and every worker see them (`cli/vitest-env`).
 * @internal
 */
export function setVitestEnv(env: NodeJS.ProcessEnv): void {
  env.TEST = 'true'
  env.VITEST = 'true'
  env.NODE_ENV ??= 'test'
  env.VITEST_MODE = 'RUN'
}

/** Vitest's reporter names that D173 maps onto Provino's own text (the human text is not reproduced). */
const TEXT_REPORTERS: Readonly<Record<string, ReporterChoice | null>> = {
  // `null`: Provino's own choice for the terminal (`provino`, `agent` or plain lines, D135).
  default: null,
  verbose: 'verbose',
  dot: 'dot',
}

/** Vitest's built-in reporter names Provino refuses by name, with why. */
const REFUSED_REPORTERS: Readonly<Record<string, string>> = {
  junit: "Vitest's junit output is not built yet (B25g)",
  'github-actions': "Vitest's github-actions annotations are not built yet (B25g)",
  tap: 'not supported under provino vitest (D173)',
  'tap-flat': 'not supported under provino vitest (D173)',
  'hanging-process': 'not supported under provino vitest (D173)',
  blob: 'not supported: --merge-reports is not built (D173)',
  html: 'not supported: @vitest/ui is not run (D173)',
  tree: 'not supported under provino vitest (D173)',
}

class VitestCommandError extends Error {}

function report(diagnostics: readonly Diagnostic[], stderr: NodeJS.WritableStream): boolean {
  let failed = false
  for (const diagnostic of diagnostics) {
    const label = diagnostic.level === 'error' ? 'error' : 'warning'
    if (diagnostic.level === 'error') failed = true
    stderr.write(`Provino: ${label}: ${diagnostic.message}\n`)
  }
  return failed
}

/** A reporter entry of `--reporter` or `test.reporters`: its name and the keys of its options. */
function reporterEntry(entry: unknown): { readonly name: string; readonly options: Rec } {
  if (typeof entry === 'string') return { name: entry, options: {} }
  if (Array.isArray(entry) && typeof entry[0] === 'string') {
    const options: unknown = entry[1]
    return {
      name: entry[0],
      options: typeof options === 'object' && options !== null ? (options as Rec) : {},
    }
  }
  throw new VitestCommandError('a reporter object or class is not supported under provino vitest')
}

type Rec = Readonly<Record<string, unknown>>

/** A reporter that takes options Provino doesn't apply: refused by name. */
function refuseOptions(name: string, options: Rec, allowed: readonly string[]): void {
  const keys = Object.keys(options).filter((key) => !allowed.includes(key))
  if (keys.length > 0) {
    throw new VitestCommandError(
      `the reporter "${name}" takes no options here (parked (D183)): ${keys.join(', ')}`,
    )
  }
}

interface ReporterPlan {
  /** The text reporters, or `undefined` for Provino's own choice. */
  readonly text: readonly ReporterChoice[] | undefined
  readonly json: boolean
  /** The json reporter's own `outputFile`, which comes before `test.outputFile` (JsonReporter). */
  readonly jsonOutputFile?: string
}

/** `--reporter` over `test.reporters` (the command line replaces the config's list, as in Vitest). */
function reporterPlan(cli: unknown, config: unknown): ReporterPlan {
  const given = cli ?? config
  // A name, a `[name, options]` pair, or a list of either.
  const pair =
    Array.isArray(given) &&
    given.length === 2 &&
    typeof given[0] === 'string' &&
    typeof given[1] === 'object' &&
    given[1] !== null &&
    !Array.isArray(given[1])
  const list: readonly unknown[] =
    given === undefined ? [] : pair || !Array.isArray(given) ? [given] : given
  if (list.length === 0) return { text: undefined, json: false }
  const text: ReporterChoice[] = []
  let implicit = false
  let json = false
  let jsonOutputFile: string | undefined
  for (const entry of list) {
    const { name, options } = reporterEntry(entry)
    if (name === 'json') {
      refuseOptions(name, options, ['outputFile'])
      json = true
      if (typeof options.outputFile === 'string') jsonOutputFile = options.outputFile
      continue
    }
    if (Object.hasOwn(TEXT_REPORTERS, name)) {
      refuseOptions(name, options, [])
      const choice = TEXT_REPORTERS[name]
      if (choice === null || choice === undefined) implicit = true
      else text.push(choice)
      continue
    }
    const refused = REFUSED_REPORTERS[name]
    throw new VitestCommandError(
      refused === undefined
        ? `the reporter "${name}" is not supported under provino vitest (a custom reporter module is not hosted yet)`
        : `the reporter "${name}" is ${refused}`,
    )
  }
  return {
    text: implicit && text.length === 0 ? undefined : text,
    json,
    ...(jsonOutputFile === undefined ? {} : { jsonOutputFile }),
  }
}

/** `outputFile`: a path for every reporter, or one per reporter name (`getOutputFile`). */
function outputFileFor(outputFile: unknown, reporter: string): string | undefined {
  if (typeof outputFile === 'string') return outputFile
  if (typeof outputFile === 'object' && outputFile !== null) {
    const own = (outputFile as Record<string, unknown>)[reporter]
    return typeof own === 'string' ? own : undefined
  }
  return undefined
}

/** `--shard=<index>/<count>`, checked as `resolveConfig` does (resolveConfig.ts L351-L368). */
function shardOf(value: unknown): ShardSpec | undefined {
  if (value === undefined || value === false) return undefined
  const [indexString = '', countString = ''] = String(value).split('/')
  const index = Math.abs(Number.parseInt(indexString, 10))
  const count = Math.abs(Number.parseInt(countString, 10))
  if (Number.isNaN(count) || count <= 0) {
    throw new VitestCommandError('--shard <count> must be a positive number')
  }
  if (Number.isNaN(index) || index <= 0 || index > count) {
    throw new VitestCommandError('--shard <index> must be a positive number less then <count>')
  }
  return { index, count }
}

/** `maxWorkers` as a count: a percentage of the machine's cores, as Vitest's `resolveConfig`. */
function maxWorkersOf(value: unknown, fileParallelism: unknown): number | undefined {
  if (fileParallelism === false) return 1
  if (typeof value === 'number' && value > 0) return Math.floor(value)
  if (typeof value === 'string' && value.endsWith('%')) {
    const share = Number.parseFloat(value) / 100
    return Math.max(1, Math.floor(availableParallelism() * share))
  }
  return undefined
}

/** A `file:line` filter, which the coordinator has no backend for: refused by name. */
function coordinatorFilter(filter: FileFilter): FileFilter {
  if (filter.kind === 'pathLine') {
    throw new VitestCommandError(
      `the location filter ${filter.value}:${String(filter.line)} is not supported yet under provino vitest (B25g)`,
    )
  }
  return filter
}

/** `--project` names, with `*` wildcards (`wildcardPatternToRegExp`), matched against each project's name. */
function chooseProjects(
  projects: readonly NeutralProject[],
  patterns: unknown,
): readonly NeutralProject[] {
  if (patterns === undefined) return projects
  const list = (Array.isArray(patterns) ? patterns : [patterns]).map(String)
  const matchers = list.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ),
  )
  const chosen = projects.filter((project) => matchers.some((m) => m.test(project.name)))
  if (chosen.length === 0) {
    // `resolveProjects` (projects/resolveProjects.ts): Vitest's own text.
    throw new VitestCommandError(`No projects matched the filter "${list.join('", "')}".`)
  }
  return chosen
}

/**
 * `provino vitest`: parse, read the config, run once, and end with Vitest's exit code.
 * @internal
 */
export async function runVitestCommand(
  args: readonly string[],
  io: VitestCommandIo,
): Promise<number> {
  setVitestEnv(process.env)
  const { stdout, stderr, cwd } = io
  try {
    // `vitest run` is the one-shot command; a bare `vitest` runs once here too (D175).
    const parsed = vitestCli.parse(args)
    if (report(parsed.diagnostics, stderr)) return VITEST_ERROR_EXIT
    const { argv } = parsed
    const request = vitestCli.toRunRequest(argv)
    if (request.mode !== 'run') {
      throw new VitestCommandError(`the ${request.mode} mode is not supported (parked (D183))`)
    }
    const { options } = argv
    const read = await readVitestConfig({
      cwd,
      ...(typeof options.root === 'string' ? { root: options.root } : {}),
      ...(typeof options.mode === 'string' ? { mode: options.mode } : {}),
      ...(request.configPath === undefined ? {} : { config: request.configPath }),
      test: vitestArgvToTestConfig(argv),
    })
    if (report(read.diagnostics, stderr)) return VITEST_ERROR_EXIT
    const rootTest = read.root.test
    const silent = options.silent ?? rootTest.silent
    if (silent === 'passed-only') {
      throw new VitestCommandError('--silent=passed-only is not supported (parked (D183))')
    }
    const neutrals = chooseProjects(read.projects, options.project)
    const ci = Boolean((io.env ?? process.env).CI)
    const projects: ResolvedProject[] = []
    for (const neutral of neutrals) {
      projects.push(
        await resolveNeutralProject(neutral, {
          dialect: vitestNodeDialect,
          environments: ENVIRONMENTS,
          ci,
        }),
      )
    }
    const [project, ...others] = projects
    if (project === undefined) throw new VitestCommandError('the config has no project to run')

    const plan =
      io.reporters === undefined
        ? reporterPlan(options.reporter, rootTest.reporters)
        : { text: io.reporters, json: false }
    const results = plan.json
      ? createVitestResults({
          roots: projects.map((each) => each.rootDir),
          passWithNoTests: request.passWithNoTests === true || rootTest.passWithNoTests === true,
          includeTaskLocation:
            options.includeTaskLocation === true || rootTest.includeTaskLocation === true,
        })
      : undefined
    const maxWorkers = maxWorkersOf(rootTest.maxWorkers, rootTest.fileParallelism)
    const shard = shardOf(options.shard)
    const bail = typeof rootTest.bail === 'number' && rootTest.bail > 0 ? rootTest.bail : 0
    const passWithNoTests = request.passWithNoTests ?? rootTest.passWithNoTests === true
    const pool: ExecuteOptions['pool'] = {
      ...(rootTest.pool === 'threads' ? { kind: 'threads' as const } : {}),
      ...(maxWorkers === undefined ? {} : { maxWorkers }),
    }
    const result = await executeProject({
      project,
      others,
      root: read.root.root,
      cwd,
      stdout,
      stderr,
      // Only `json`: no text at all, as Vitest prints only the report's line.
      ...(plan.text === undefined
        ? {}
        : { reporters: plan.text.length === 0 && plan.json ? [] : plan.text }),
      ...(results === undefined ? {} : { leadingReporters: [results.reporter] }),
      env: io.env ?? process.env,
      display: {
        ...(silent === true ? { silent: true } : {}),
        ...(request.colour === undefined ? {} : { colour: request.colour }),
      },
      pool,
      testNamePattern: request.namePattern,
      update: request.update,
      fileFilters: request.fileFilters.map(coordinatorFilter),
      passWithNoTests,
      ...(bail > 0 ? { bail: { count: bail } } : {}),
      ...(rootTest.logHeapUsage === true ? { logHeapUsage: true } : {}),
      ...(shard === undefined ? {} : { shard }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
    })
    if (result.summary !== null && result.summary.files.length === 0) {
      // `Logger.printNoTestFound` (logger.ts L167-L184): stdout under `passWithNoTests`, else stderr.
      if (passWithNoTests) await stdout.write('No test files found, exiting with code 0\n\n')
      else stderr.write('No test files found, exiting with code 1\n\n')
    }
    if (results !== undefined && result.summary !== null) {
      await writeJsonReport(
        JSON.stringify(results.json()),
        plan.jsonOutputFile ?? outputFileFor(options.outputFile ?? rootTest.outputFile, 'json'),
        read.root.root,
        stdout,
      )
    }
    return result.exitCode
  } catch (error) {
    if (error instanceof VitestCliError) {
      stderr.write(`${error.upstreamName}: ${error.message}\n`)
      return VITEST_ERROR_EXIT
    }
    if (error instanceof VitestCommandError || error instanceof VitestConfigError) {
      stderr.write(`Error: ${error.message}\n`)
      return VITEST_ERROR_EXIT
    }
    const message = usageMessage(error)
    if (message === undefined) throw error
    stderr.write(`${message}\n`)
    return VITEST_ERROR_EXIT
  }
}

/**
 * `JsonReporter.writeReport` (reporters/json.ts L227-L246): to `outputFile` (from the root), else to
 * `<root>/.vitest/json/output.json` (`createReport('json')`), and Vitest's line on stdout.
 */
async function writeJsonReport(
  text: string,
  outputFile: string | undefined,
  root: string,
  stdout: TextSink,
): Promise<void> {
  const reportFile =
    outputFile === undefined
      ? resolve(root, '.vitest', 'json', 'output.json')
      : resolve(root, outputFile)
  await mkdir(dirname(reportFile), { recursive: true })
  await writeFile(reportFile, text, 'utf-8')
  await stdout.write(`JSON report written to ${reportFile}\n`)
}
