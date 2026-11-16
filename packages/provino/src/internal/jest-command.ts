// `provino jest <jest arguments>` (T11.13, U3): the Jest command line, parsed by the Jest dialect's
// own parser, layered over the project Jest's config reader finds, run by the same coordinator
// as `provino run`, and ended with Jest's exit codes.
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { type ResolvedProject, resolveNeutralProject } from '@provino/config'
import {
  createJestConfigReader,
  createJestResults,
  JEST_CLEAR_LINE,
  JEST_NO_SCM_TEXT,
  type JestArgv,
  JestCliError,
  JestConfigError,
  type JestFilter,
  type JestGlobalConfig,
  JestNotifierMissingError,
  type JestProjectConfig,
  JestWatchPluginError,
  jestChangedFilesErrorText,
  jestChangedNoTestsMessage,
  jestCli,
  jestCollectedText,
  jestCoverageOptions,
  jestCoverageTexts,
  jestDebugText,
  jestNodeDialect,
  jestRunGlobalHooks,
  loadJestFilter,
  packageJsonKey,
  processJestResults,
  readJestConfigs,
} from '@provino/dialect-jest/node'
import {
  type AffectedLookupOptions,
  type ChangeSource,
  type DiscoveredFile,
  defaultCacheDir,
  discoverProject,
  ExitCode,
  isProvinoCacheDir,
  type RunCoverageHooks,
  readTimings,
  type ShardSpec,
  shardFiles,
  TIMINGS_FILE_NAME,
} from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { ConfigSource, Diagnostic, NeutralProject, RunRequest } from '@provino/types'
import type { ReporterChoice } from '../types.ts'
import { JEST_BUILT_INS, JEST_ENVIRONMENT, NODE_ENVIRONMENT } from './built-ins.ts'
import type { CoverageReporter } from './coverage-reporter.ts'
import { usageMessage } from './describe.ts'
import { type ExecuteOptions, executeProject, timingsOf } from './execute.ts'
import { setUpJestReporters } from './jest-reporters.ts'
import { noRootConfigHintReporter } from './jest-root-hint.ts'
import {
  isScmCommandFailure,
  type JestSelection,
  jestSelection,
  keepFailedFiles,
  selectProjectFiles,
  withChangedCoverage,
} from './jest-selection.ts'
import { type JestWatchInput, runJestWatch } from './jest-watch.ts'
import { type DisplayOptions, outputFor, styleFor, styleOf } from './reporters.ts'
import {
  chooseProjects,
  noProjectsMessage,
  selectionFromArgv,
  selectionMessage,
} from './select-projects.ts'
import { UsageError } from './usage-error.ts'

/**
 * Where the command reads and writes.
 * @internal
 */
export interface JestCommandIo {
  readonly stdout: TextSink
  readonly stderr: NodeJS.WritableStream
  readonly cwd: string
  /**
   * Reporters in place of the policy's defaults. `provino jest` has no flag for them yet (T11.9),
   * so only a caller of this module sets it (the tests that read each test's status).
   */
  readonly reporters?: readonly ReporterChoice[]
  /** What the reporters read for the terminal, CI, an agent and colour. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Aborted by the first SIGINT or SIGTERM: the run ends 130 or 143. Default: never. */
  readonly signal?: AbortSignal
  /** Aborted by the second signal: every worker is killed at once. */
  readonly forceSignal?: AbortSignal
  /**
   * Called once when `--forceExit` is on and the run is over (after the reporters have written):
   * the process should end now, with the exit code returned, whatever a test left open. The bin
   * exits from it; this module never calls `process.exit`.
   */
  readonly onForceExit?: () => void
  /** Where `--watch` reads keys (default `process.stdin`). */
  readonly stdin?: JestWatchInput
  /** Where `--watch` hears of changes, in place of the file watcher (a test's). */
  readonly watchChanges?: ChangeSource
  /** The seam a test counts affected-index builds through (`createIndex`). */
  readonly affectedLookup?: AffectedLookupOptions
}

/** The version of Jest the dialect mirrors, for `--showConfig`. */
const JEST_VERSION = '30.5.2'

/** What Jest 30.5.2's `--forceExit` says before it exits, when `--detectOpenHandles` isn't on. */
const FORCE_EXIT_WARNING =
  'Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?'

/**
 * One of the Jest dialect's own `orchestrator.exitCodes` (`usage` for a command line or config
 * Jest refuses, `cli/unknown-flag` and `cli/bad-config`; `noTests` for a run that found none),
 * else the neutral `fallback`.
 */
function jestExitCode(key: 'usage' | 'noTests', fallback: number): number {
  const { policy } = jestNodeDialect
  if (typeof policy === 'function') return fallback
  return policy.orchestrator?.exitCodes?.[key] ?? fallback
}

/**
 * The environments a project may name. A run needs a built-in one, so a project whose
 * environment isn't (jsdom, a custom one) is refused before anything starts. Listing the files and
 * clearing the cache start no worker, so they accept any name, as Jest's `--listTests` does.
 */
function environmentsFor(request: RunRequest, project: NeutralProject): typeof JEST_BUILT_INS {
  const { name } = project.environment
  if (Object.hasOwn(JEST_BUILT_INS, name)) return JEST_BUILT_INS
  // Any other environment is the project's own Jest class (D44), run through the adapter.
  if (typeof project.environment.options.module === 'string')
    return { ...JEST_BUILT_INS, [name]: JEST_ENVIRONMENT }
  if (request.mode === 'run') return JEST_BUILT_INS
  return { ...JEST_BUILT_INS, [name]: NODE_ENVIRONMENT }
}

/**
 * Jest's `workerIdleMemoryLimit` as the pool's recycle policy. The config reader has already done
 * what jest-config's `stringToBytes` does (`'512MB'`, `'50%'` and `0.2` are bytes by now), and
 * jest-runner hands the number to jest-worker as it is: `0` replaces a child process after every
 * file, any other is a count of bytes. Absent: the pool's own default limit. A divergence
 * (DIVERGENCES, B21a): jest-worker compares the child's `heapUsed`, the pool compares a forked
 * child's RSS (a thread's used heap, as jest-worker does), so Provino recycles a little earlier
 * under forks.
 * @internal
 */
export function workerRecycle(limit: number | undefined): {
  readonly recycle?: { readonly memoryLimitBytes: number }
} {
  return limit === undefined ? {} : { recycle: { memoryLimitBytes: limit } }
}

/** What jest-cli prints for an error that ends `runCLI`: its stack, else the text of what was thrown. */
function stackText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? String(error)) : String(error)
}

/** A diagnostic as a line (or lines) for the user. Jest's own texts keep their form. */
function describeDiagnostic(diagnostic: Diagnostic): string {
  if (diagnostic.message.trimStart().startsWith('●')) return diagnostic.message
  return `Provino: ${diagnostic.level === 'warning' ? 'warning: ' : ''}${diagnostic.message}`
}

/** Writes the diagnostics to `stderr`; true when any is an error. */
function report(diagnostics: readonly Diagnostic[], stderr: NodeJS.WritableStream): boolean {
  let failed = false
  for (const diagnostic of diagnostics) {
    stderr.write(`${describeDiagnostic(diagnostic)}\n`)
    if (diagnostic.level === 'error') failed = true
  }
  return failed
}

/**
 * How Jest's presentation flags and config keys look to the reporters: `verbose` (the global config
 * or any project; `false` only when the global config says so on purpose), `silent`, `expand` and
 * `noStackTrace` from the merged global config, and the colour request from `--color`, `--colors`
 * and `--no-color`. A run of exactly one test file is verbose too, as `runJest` has it, which the
 * dialect's `report.listTestsForSingleFile` and these two inputs (`silent`, `verbose: false`) give
 * the reporter to decide.
 */
function presentation(
  read: { readonly verbose: boolean; readonly globalConfig: JestGlobalConfig },
  request: RunRequest,
): DisplayOptions {
  const { globalConfig } = read
  return {
    ...(read.verbose
      ? { verbose: true }
      : globalConfig.verbose === false
        ? { verbose: false }
        : {}),
    ...(globalConfig.silent === true ? { silent: true } : {}),
    ...(globalConfig.expand ? { expand: true } : {}),
    ...(globalConfig.noStackTrace ? { noStackTrace: true } : {}),
    ...(request.colour === undefined ? {} : { colour: request.colour }),
  }
}

/** Jest's `verbose`: the global config's, or that of any of the projects that run. */
function selectedVerbose(
  globalConfig: JestGlobalConfig,
  configs: readonly JestProjectConfig[],
): boolean {
  return globalConfig.verbose === true || configs.some((config) => config.verbose === true)
}

/**
 * The pool a `provino jest` run asks for: `--workerThreads` is the pool for a run that is not in
 * band (Jest's `shouldRunInBand` never reads it, so a single file still runs in this process), the
 * worker count as Jest normalized it, and `workerIdleMemoryLimit`.
 */
function poolFor(globalConfig: JestGlobalConfig, request: RunRequest): ExecuteOptions['pool'] {
  return {
    ...(request.workerThreads === true ? { kind: 'threads' as const, automaticInBand: true } : {}),
    maxWorkers: globalConfig.maxWorkers,
    ...workerRecycle(globalConfig.workerIdleMemoryLimit),
  }
}

/** The shard the global config holds (`--shard`), as the coordinator takes it. */
function shardOf(globalConfig: JestGlobalConfig): ShardSpec | undefined {
  const { shard } = globalConfig
  return shard === undefined ? undefined : { index: shard.shardIndex, count: shard.shardCount }
}

/** The projects of the config the request names (or the one found from `cwd`), unresolved. */
async function readProjects(
  argv: JestArgv,
  request: RunRequest,
  cwd: string,
): Promise<{
  readonly neutral: readonly NeutralProject[]
  readonly globalConfig: JestGlobalConfig
  /** Each project's Jest config, in the order of `neutral`. */
  readonly configs: readonly JestProjectConfig[]
  readonly cache: boolean
  /** Jest's `verbose`: the global config's, or any project's. */
  readonly verbose: boolean
  readonly showable: unknown
  readonly diagnostics: readonly Diagnostic[]
  /**
   * The run reads no Jest config: no `--config`, no `--projects`, and the search from the working
   * directory ended at no file or at a `package.json` with no `jest` key (Jest reads `{}` there).
   */
  readonly noConfig: boolean
}> {
  const reader = createJestConfigReader({ argv, cwd })
  // `--projects a b`: Jest reads those paths' configs and looks for none from the working
  // directory (`getProjectListFromCLIArgs`, then `readConfigs(argv, projects)`).
  const projectPaths = Array.isArray(argv.projects) ? argv.projects.map(String) : []
  let resolved: Awaited<ReturnType<typeof reader.resolve>>
  let noConfig = false
  if (projectPaths.length > 0) {
    const read = await readJestConfigs(projectPaths, { argv, cwd })
    resolved = {
      value: {
        globalConfig: read.globalConfig,
        configs: read.configs,
        cacheDirectorySet: read.cacheDirectorySet,
      },
      diagnostics: read.diagnostics,
    }
  } else {
    // No config file: Jest runs with its defaults over the working directory.
    const found = await reader.find(cwd, request.configPath)
    const source: ConfigSource = found ?? { kind: 'inline', path: cwd, text: '{}' }
    noConfig =
      request.configPath === undefined &&
      (found === undefined ||
        (found.kind === 'package-json' && !packageJsonKey(found.path, 'jest')))
    const raw = await reader.load(source)
    resolved = await reader.resolve(raw, source)
  }
  const neutral = reader.toNeutral(resolved.value)
  return {
    neutral: neutral.value,
    globalConfig: resolved.value.globalConfig,
    configs: resolved.value.configs,
    cache: resolved.value.configs.every((config) => config.cache),
    verbose:
      resolved.value.globalConfig.verbose === true ||
      resolved.value.configs.some((config) => config.verbose === true),
    showable: { globalConfig: resolved.value.globalConfig, configs: resolved.value.configs },
    diagnostics: [...resolved.diagnostics, ...neutral.diagnostics],
    noConfig,
  }
}

/**
 * What `--listTests` needs to apply a shard: Jest's `--shard=i/n` and Provino's `--timings <file>`
 * (`--update-timings` writes after a run, and a listing has none).
 */
interface ShardRequest {
  readonly shard: ShardSpec | undefined
  readonly timingsFile: string | undefined
}

/**
 * Takes Provino's own `--timings <file>` / `--timings=<file>` and `--update-timings` out of a
 * `provino jest` command line, since Jest's parser would refuse them as unknown flags. Everything
 * after a `--` is Jest's (a path pattern named like a flag is a pattern), and a `--timings` whose
 * value is missing, empty or another flag is a usage error, so it never takes the next flag.
 */
function takeTimingsFlags(args: readonly string[]): {
  readonly rest: readonly string[]
  readonly timingsFile: string | undefined
  readonly updateTimings: boolean
} {
  const rest: string[] = []
  let timingsFile: string | undefined
  let updateTimings = false
  // `--timings=-x` names a file called `-x`; the next argument of `--timings x` that starts with `-` is a flag.
  const needsPath = (value: string | undefined, spaced: boolean): string => {
    if (value === undefined || value === '' || (spaced && value.startsWith('-'))) {
      throw new UsageError('--timings needs the path of a timings file')
    }
    return value
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '--') {
      rest.push(...args.slice(index))
      break
    }
    if (arg === '--update-timings') {
      updateTimings = true
    } else if (arg === '--timings') {
      timingsFile = needsPath(args[++index], true)
    } else if (arg.startsWith('--timings=')) {
      timingsFile = needsPath(arg.slice('--timings='.length), false)
    } else {
      rest.push(arg)
    }
  }
  return { rest, timingsFile, updateTimings }
}

/** The real path of the working directory, as jest-config's `normalize` keeps it (`tryRealpath`). */
function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * A project's files that `--filter` keeps: the filter is called with their absolute paths once per
 * project, as Jest's `runJest` calls it, however often the run asks (the reporters' file count and
 * the run itself both do), and its answer is kept for that project.
 */
type ProjectFilter = <T extends { readonly path: string }>(
  project: ResolvedProject,
  files: readonly T[],
) => Promise<readonly T[]>

function oncePerProject(filter: JestFilter): ProjectFilter {
  const kept = new Map<ResolvedProject, Promise<ReadonlySet<string>>>()
  return async (project, files) => {
    let paths = kept.get(project)
    if (paths === undefined) {
      paths = filter(files.map((file) => file.path)).then((list) => new Set(list))
      kept.set(project, paths)
    }
    const keep = await paths
    return files.filter((file) => keep.has(file.path))
  }
}

/** How a run selects its files: the shard and its timings, `--filter`, and the changed-file flags. */
type Sharding = ShardRequest & {
  readonly runRoot: string
  readonly filter?: ProjectFilter | undefined
  readonly selection: JestSelection
  /** `false` under `--no-cache`: no edge cache and no results history. */
  readonly cache: boolean
}

/** Each project's files before the shard, in `projects`' order. */
type BeforeShard = () => Promise<readonly (readonly DiscoveredFile[])[]>

/**
 * Each project's files before the shard (the filters, or the changed-file selection in their
 * place, then `--filter`), worked out once however often it is asked: the selection builds each
 * project's loader and affected index, which the listing, the reporters' count, the no-tests text
 * and the run all read.
 */
function selectedBeforeShard(
  projects: readonly ResolvedProject[],
  request: RunRequest,
  cwd: string,
  sharding: Pick<Sharding, 'filter' | 'selection' | 'cache'>,
): BeforeShard {
  let once: Promise<readonly (readonly DiscoveredFile[])[]> | undefined
  return () => {
    once ??= Promise.all(
      projects.map(async (project) => {
        const files = await selectProjectFiles(project, await discoverProject(project), {
          selection: sharding.selection,
          fileFilters: request.fileFilters,
          cwd,
          cache: sharding.cache,
        })
        return sharding.filter === undefined ? files : sharding.filter(project, files)
      }),
    )
    return once
  }
}

/**
 * Each project's selected test files (the filters applied, or the changed-file selection in their
 * place, then `--filter`, then the shard, then `--onlyFailures`), one list per project.
 */
async function selectedPerProject(
  projects: readonly ResolvedProject[],
  cwd: string,
  sharding: Sharding,
  beforeShard: BeforeShard,
): Promise<readonly (readonly { readonly path: string }[])[]> {
  const sharded = await shardedPerProject(projects, cwd, sharding, beforeShard)
  if (sharding.selection.onlyFailures === undefined) return sharded
  return sharded.map((files, index) => {
    const project = projects[index]
    return project === undefined ? files : keepFailedFiles(project, files, sharding.cache)
  })
}

async function shardedPerProject(
  projects: readonly ResolvedProject[],
  cwd: string,
  sharding: Sharding,
  beforeShard: BeforeShard,
): Promise<readonly (readonly DiscoveredFile[])[]> {
  const selected = await beforeShard()
  const [first] = projects
  const { shard } = sharding
  return shard === undefined || first === undefined
    ? selected
    : shardFiles(
        projects.map((project, index) => ({
          rootDir: project.rootDir,
          files: selected[index] ?? [],
        })),
        {
          shard,
          fallback: first.policy.orchestrator.shard.fallback,
          runRoot: sharding.runRoot,
          timings: await readTimings(
            resolve(cwd, sharding.timingsFile ?? join(sharding.runRoot, TIMINGS_FILE_NAME)),
          ),
        },
      )
}

/**
 * The coverage of a `provino jest` run, when the global config collects it (either provider):
 * Jest's CoverageReporter, and the notice `_addUntestedFiles` writes on a terminal while the files
 * no test loaded are covered (`RUNNING_TEST_COLOR`, bold dim, then `clearLine`). The reporter and
 * the threshold hook are the same for either provider (`CoverageSummary` holds the map, whatever
 * collected it): what a provider adds is its collector in the workers' config, which the dialect's
 * `to-neutral` supplies.
 */
async function coverageFor(
  globalConfig: JestGlobalConfig,
  /** Jest's `--passWithNoTests` or a `-o` that found no test: the empty run is reported. */
  reportEmptyRun: boolean,
  io: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly stdout: TextSink
    readonly stderr: NodeJS.WritableStream
    /** `--colors` or `--no-color`: supports-color reads them from the command line, as Jest's does. */
    readonly colour: boolean | undefined
  },
): Promise<{ readonly reporter: CoverageReporter; readonly hooks: RunCoverageHooks } | undefined> {
  if (!globalConfig.collectCoverage) return undefined
  // The reporter brings `@provino/coverage/node`: loaded only when the run collects (T1.10).
  const { createCoverageReporter } = await import('./coverage-reporter.ts')
  const { env, stdout, stderr } = io
  const columns = (stdout as { columns?: unknown }).columns
  // Jest's chalk and `istanbul-lib-report`'s console writer follow stdout's colour support.
  const output = outputFor({ env, stderr: stdout, ci: globalConfig.ci, colour: io.colour })
  const style = styleOf(output)
  const options = jestCoverageOptions(globalConfig, {
    env,
    stdoutColumns: typeof columns === 'number' && columns > 0 ? columns : undefined,
  })
  const reporter = createCoverageReporter({
    options,
    stdout,
    stderr,
    consoleColour: output.colour,
    style,
    texts: jestCoverageTexts,
  })
  // jest-util's `isInteractive`: stdout a terminal, not dumb, not CI.
  const interactive = output.live
  // The thresholds are checked in the coordinator (`CoverageSummary.thresholdFailures`); Jest
  // resolves a relative group against the process's directory.
  const hooks: RunCoverageHooks = {
    thresholds: options.thresholds,
    thresholdsCwd: io.cwd,
    // runJest.ts: with no test file Jest ends with its message, unless `--passWithNoTests` lets the
    // scheduler run on an empty list, which the CoverageReporter then reports.
    reportEmptyRun,
    ...(interactive
      ? {
          onUntested: {
            start: () => stderr.write(style.bold(style.dim(jestCoverageTexts.untestedNotice))),
            // `clearLine(process.stderr)`: only on a terminal.
            end: () => {
              if ((stderr as { isTTY?: unknown }).isTTY === true)
                stderr.write('\u001b[999D\u001b[K')
            },
          },
        }
      : {}),
  }
  return { reporter, hooks }
}

/**
 * The colour request Jest's chalk acts on: supports-color 7.2.0 (chalk 4's) lets a `FORCE_COLOR` in
 * the environment override `--color`, `--colors` and `--no-color` (index.js L21-L29 set `forceColor`
 * from it after the flags, and L45 returns 0 for `FORCE_COLOR=0`), and never reads `NO_COLOR`.
 * `detectOutput` puts an explicit request above the environment, so under the Jest dialect the
 * request is the environment's when it forces a level, else the flag's.
 * @internal
 */
export function jestColourRequest(
  env: Readonly<Record<string, string | undefined>>,
  flag: boolean | undefined,
): boolean | undefined {
  const forced = env.FORCE_COLOR
  if (forced === undefined) return flag
  const level =
    forced === 'true'
      ? 1
      : forced === 'false'
        ? 0
        : forced.length === 0
          ? 1
          : Number.parseInt(forced, 10)
  return Number.isNaN(level) ? flag : level > 0
}

/**
 * Runs one `provino jest` command line and resolves with the exit code. Bad input (a flag Jest
 * refuses or Provino can't run yet, a config Jest refuses, a pattern that isn't a regular
 * expression) is a message on `stderr` and Jest's exit code for it; any other error is a bug and
 * rejects.
 * @internal
 */
export async function runJestCommand(args: readonly string[], io: JestCommandIo): Promise<number> {
  const { stdout, stderr, cwd } = io
  const usage = jestExitCode('usage', ExitCode.UsageError)
  /** What `--filter` threw (loading it, its `setup`, or a bad result): Jest ends with that error's stack. */
  let filterError: unknown
  try {
    const { rest, timingsFile, updateTimings } = takeTimingsFlags(args)
    const parsed = jestCli.parse(rest)
    if (report(parsed.diagnostics, stderr)) return usage
    const parsedRequest = jestCli.toRunRequest(parsed.argv)
    const colour = jestColourRequest(io.env ?? process.env, parsedRequest.colour)
    const request: RunRequest = {
      ...parsedRequest,
      ...(colour === undefined ? {} : { colour }),
    }
    const read = await readProjects(parsed.argv, request, cwd)
    if (report(read.diagnostics, stderr)) return usage

    // `--debug` (`runCLI`): the config as JSON, before anything else, on the output stream.
    if (parsed.argv.debug === true) {
      const text = jestDebugText(read.globalConfig, read.configs, JEST_VERSION)
      if (parsed.argv.json === true || parsed.argv.useStderr === true) stderr.write(text)
      else await stdout.write(text)
    }

    if (request.mode === 'show-config') {
      await stdout.write(
        `${JSON.stringify({ ...(read.showable as object), version: JEST_VERSION }, null, '  ')}\n`,
      )
      return ExitCode.Pass
    }

    // `--selectProjects` / `--ignoreProjects` (D69): Jest clears the cache of every project, and
    // says what it selected, on the output stream, before it lists or runs the chosen ones.
    const selection = selectionFromArgv(parsed.argv)
    // Under `--json` or `--useStderr` the output stream is stderr, so stdout stays parseable.
    const writeOut = async (message: string): Promise<void> => {
      if (parsed.argv.json === true || parsed.argv.useStderr === true) stderr.write(message)
      else await stdout.write(message)
    }
    const selecting = selection !== undefined && request.mode !== 'clear-cache'
    const neutrals = selecting ? chooseProjects(read.neutral, selection) : read.neutral
    const noneSelected = selecting && neutrals.length === 0
    if (selecting) await writeOut(selectionMessage(read.neutral, neutrals, selection))

    const projects: ResolvedProject[] = []
    for (const neutral of neutrals) {
      projects.push(
        await resolveNeutralProject(neutral, {
          dialect: jestNodeDialect,
          environments: environmentsFor(request, neutral),
          ci: read.globalConfig.ci,
        }),
      )
    }

    if (request.mode === 'clear-cache') {
      // Projects often share a directory; Jest names each once.
      const directories = new Set(
        projects.map((project) => defaultCacheDir(project.rootDir, project.cacheDirectory)),
      )
      for (const directory of directories) {
        if (existsSync(directory) && !isProvinoCacheDir(directory)) {
          // `<cacheDirectory>/provino` can be a directory the user had before Provino.
          await stderr.write(
            `Provino: left ${directory}: it is not a Provino cache (no CACHEDIR.TAG, results.json or t/lockfile-hash).\n`,
          )
          continue
        }
        await rm(directory, { recursive: true, force: true })
        await stdout.write(`Cleared ${directory}\n`)
      }
      return ExitCode.Pass
    }
    // The changed-file flags (T9.16): `-o`'s lookup runs once, before the listing or the run, and a
    // failure ends the command as `getChangedFilesPromise` does (L28-L37): the error in red, exit 1.
    const selectedConfigs = neutrals.flatMap((neutral) => {
      const config = read.configs[read.neutral.indexOf(neutral)]
      return config === undefined ? [] : [config]
    })
    const env = io.env ?? process.env
    // `--watch` / `--watchAll` (B23c Phase 8): Jest's watch loop on a watch session, which selects
    // every run's files itself. A static import: a chunk of its own would share the dialect's
    // `/node` with the bin's and move it into the chunk the worker loads.
    if (request.mode === 'run' && (read.globalConfig.watch || read.globalConfig.watchAll)) {
      let watchFilter: JestFilter | undefined
      try {
        watchFilter = loadJestFilter(read.globalConfig)
      } catch (error) {
        filterError = error
        throw error
      }
      const hooks = jestRunGlobalHooks(read.globalConfig)
      return await runJestWatch({
        globalConfig: read.globalConfig,
        projects,
        configs: selectedConfigs,
        request,
        cwd,
        stdout,
        stderr,
        env,
        pool: poolFor(read.globalConfig, request),
        display: (globalConfig, verbose) =>
          presentation(
            { verbose: verbose || selectedVerbose(globalConfig, selectedConfigs), globalConfig },
            request,
          ),
        ...(watchFilter === undefined ? {} : { filter: watchFilter }),
        ...(hooks === undefined ? {} : { globalSetup: hooks }),
        ...(io.stdin === undefined ? {} : { stdin: io.stdin }),
        ...(io.signal === undefined ? {} : { signal: io.signal }),
        ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
        ...(io.watchChanges === undefined ? {} : { changes: io.watchChanges }),
      })
    }
    let fileSelection: JestSelection
    try {
      fileSelection = await jestSelection(
        read.globalConfig,
        projects,
        selectedConfigs,
        realCwd(cwd),
        io.affectedLookup,
      )
    } catch (error) {
      // Only a command the provider ran and that failed is Jest's red text (`exec.ts`'s
      // `JEST_SCM_COMMAND_FAILED`); anything else is an internal error, with its stack.
      if (!isScmCommandFailure(error)) throw error
      const [firstConfig] = selectedConfigs
      stderr.write(
        `${jestChangedFilesErrorText(
          error,
          firstConfig ?? { rootDir: read.globalConfig.rootDir, testMatch: [] },
          styleFor({ env, stream: stdout, ci: read.globalConfig.ci, colour: request.colour }),
        )}\n`,
      )
      return ExitCode.TestFailure
    }
    const useCache = request.cache !== false && read.cache
    // Only the `-o` modes restrict coverage (runJest.ts L403-L421). `--findRelatedTests` does not:
    // Jest 30.5.2 builds `SearchResult.collectCoverageFrom` (SearchSource.ts L196-L231) and never
    // reads it in `runJest`, so coverage there counts every `collectCoverageFrom` file
    // (`coverage/find-related`, held by `test/jest-coverage-changed.test.ts`).
    if (
      read.globalConfig.collectCoverage &&
      !read.globalConfig.collectTests &&
      request.mode === 'run'
    ) {
      projects.splice(
        0,
        projects.length,
        ...(await withChangedCoverage(projects, fileSelection, useCache)),
      )
    }
    // runJest.ts L113-L119: each project left with no test under `-o` outside any repository says so.
    const announceNoScm = async (perProject: readonly (readonly unknown[])[]): Promise<void> => {
      if (!fileSelection.noScm) return
      for (const files of perProject) {
        if (files.length === 0) await writeOut(`${JEST_NO_SCM_TEXT}\n`)
      }
    }
    // `--filter`: loaded as `runCLI` does, once the run or the listing is certain (the exits above
    // come first), and a failure to load, set up or use it ends the run with its stack.
    let filter: JestFilter | undefined
    try {
      filter = loadJestFilter(read.globalConfig)
    } catch (error) {
      filterError = error
      throw error
    }
    const guardedFilter: ProjectFilter | undefined =
      filter === undefined
        ? undefined
        : oncePerProject(async (paths) => {
            try {
              return await filter(paths)
            } catch (error) {
              filterError = error
              throw error
            }
          })
    const sharding: Sharding = {
      shard: shardOf(read.globalConfig),
      timingsFile,
      runRoot: read.globalConfig.rootDir,
      filter: guardedFilter,
      selection: fileSelection,
      cache: useCache,
    }
    const beforeShard = selectedBeforeShard(projects, request, cwd, sharding)
    if (request.mode === 'list-files') {
      const perProject = await selectedPerProject(projects, cwd, sharding, beforeShard)
      await announceNoScm(perProject)
      const files = [...new Set(perProject.flatMap((list) => list.map((file) => file.path)))].sort()
      if (!request.json) {
        await stdout.write(files.map((file) => `${file}\n`).join(''))
        return ExitCode.Pass
      }
      // `--json --outputFile`: Jest writes the list where the results would go.
      const outputFile = parsed.argv.outputFile
      if (typeof outputFile === 'string' && outputFile !== '') {
        await mkdir(dirname(resolve(cwd, outputFile)), { recursive: true })
        await writeFile(resolve(cwd, outputFile), JSON.stringify(files))
      } else {
        await stdout.write(`${JSON.stringify(files)}\n`)
      }
      return ExitCode.Pass
    }

    const [project, ...others] = projects
    if (project === undefined) {
      if (!noneSelected) throw new UsageError('the config has no project to run')
      if (read.globalConfig.collectTests) {
        // runJest.ts L333-L339: with no test, `--collectTests` says so on stdout and exits 0.
        await stdout.write('No tests found.\n')
        return ExitCode.Pass
      }
      // A selection that left no project: Jest runs nothing and says there are no tests.
      const passWithNoTests = read.globalConfig.passWithNoTests
      const message = noProjectsMessage({
        rootDir: read.globalConfig.rootDir,
        passWithNoTests,
        byPath: parsed.argv.runTestsByPath === true,
        filters: request.fileFilters,
      })
      await writeOut(message)
      return passWithNoTests ? ExitCode.Pass : jestExitCode('noTests', ExitCode.TestFailure)
    }
    // The run's files, worked out once: the reporters' count (Jest decides from the tests it will
    // run) and the changed-file flags' no-tests texts read them.
    let runFilesOnce: Promise<readonly (readonly { readonly path: string }[])[]> | undefined
    const runFiles = (): Promise<readonly (readonly { readonly path: string }[])[]> => {
      runFilesOnce ??= selectedPerProject(projects, cwd, sharding, beforeShard)
      return runFilesOnce
    }
    // `getNoTestsFoundMessage.ts` L16-L34 for `-o` and `--onlyFailures`: with no test the message
    // goes to the output stream, and the run ends 0 when `passWithNoTests || lastCommit ||
    // onlyChanged` (runJest.ts L369-L381), else with the no-tests code.
    const changedMessage = jestChangedNoTestsMessage(read.globalConfig, {
      interactive: outputFor({ env, stderr: stdout, ci: read.globalConfig.ci }).live,
      style: styleFor({ env, stream: stdout, ci: read.globalConfig.ci, colour: request.colour }),
    })
    if (changedMessage !== undefined && !read.globalConfig.collectTests) {
      const perProject = await runFiles()
      if (perProject.every((files) => files.length === 0)) {
        await announceNoScm(perProject)
        await writeOut(`${changedMessage.message}\n`)
        // runJest.ts L369-L381 prints the message and goes on: with coverage on, the empty run's
        // reports are still written (`coverage/only-changed-no-git`), so only a run with no
        // coverage ends here.
        const reportsEmptyRun =
          changedMessage.exitWith0 && request.mode === 'run' && read.globalConfig.collectCoverage
        if (!reportsEmptyRun) {
          return changedMessage.exitWith0
            ? ExitCode.Pass
            : jestExitCode('noTests', ExitCode.TestFailure)
        }
      }
    }
    // `-o` and `--findRelatedTests` select in place of the filters: the files were selected once
    // above (the loader and the affected index are built once), so the run is handed them as each
    // project's own filter, before the shard, as `runProjects` would have selected them.
    // `--onlyFailures` reads the history after the shard; under `--no-cache` there is none, and the
    // command has already ended with Jest's no-tests text.
    const preselected = fileSelection.selection !== undefined
    // `--onlyFailures --no-cache --collectTests` gets here with nothing to keep.
    const noHistory = fileSelection.onlyFailures !== undefined && !useCache
    const runSelection: Pick<
      Parameters<typeof executeProject>[0],
      'fileFilters' | 'fileFilter' | 'onlyFailures'
    > = {
      ...(preselected ? {} : { fileFilters: request.fileFilters }),
      ...(noHistory
        ? { fileFilter: async () => [] }
        : preselected
          ? {
              fileFilter: async (own, files) => {
                const index = projects.indexOf(own)
                const keep = new Set(((await beforeShard())[index] ?? []).map((file) => file.path))
                return files.filter((file) => keep.has(file.path))
              },
            }
          : guardedFilter === undefined
            ? {}
            : { fileFilter: (filtered, files) => guardedFilter(filtered, files) }),
      ...(fileSelection.onlyFailures !== undefined && useCache
        ? { onlyFailures: fileSelection.onlyFailures }
        : {}),
    }
    const runHooks = jestRunGlobalHooks(read.globalConfig)
    const shard = shardOf(read.globalConfig)
    // `--json` and `testResultsProcessor` read the run as Jest's `AggregatedResult`: a collector
    // first on the bus builds it from the events (`processResults`, runJest.ts L173-L213).
    // `--collectTests` (runJest.ts L334-L367) runs no global setup and no reporter: the collector
    // alone hears the run, whose files report what their tests would do.
    const collecting = read.globalConfig.collectTests
    const newResults = (): ReturnType<typeof createJestResults<JestProjectConfig>> =>
      createJestResults({
        ...(collecting ? { collectOnly: true } : {}),
        globalConfig: read.globalConfig,
        projectConfigs: selectedConfigs,
      })
    const results =
      collecting || read.globalConfig.json || read.globalConfig.testResultsProcessor !== undefined
        ? newResults()
        : undefined
    // The reporters (Jest's failure text, the classes a config names) read the same results; a run
    // that neither writes JSON nor runs a processor keeps its own exit code.
    const reporterResults = results ?? (collecting ? undefined : newResults())
    // An empty run is a pass under `--passWithNoTests`, and for the `-o` modes that end 0 with no
    // test (runJest.ts L369-L381); then its coverage reports are still written.
    const emptyRunOk = read.globalConfig.passWithNoTests || changedMessage?.exitWith0 === true
    // `--coverage` (B23b): Jest's CoverageReporter, and the notice on a terminal while the files no
    // test loaded are covered. A `--collectTests` run collects nothing.
    const coverage = collecting
      ? undefined
      : await coverageFor(read.globalConfig, emptyRunOk, {
          cwd,
          env,
          stdout,
          stderr,
          colour: request.colour,
        })
    const setup =
      collecting || io.reporters !== undefined || reporterResults === undefined
        ? undefined
        : await setUpJestReporters({
            globalConfig: read.globalConfig,
            configs: selectedConfigs,
            // Jest decides from the tests it will run (`tests.some(...)`, `shouldRunInBand`).
            filesPerProject: async () => (await runFiles()).map((list) => list.length),
            results: reporterResults,
            output: outputFor({ env, stderr, ci: read.globalConfig.ci, colour: request.colour }),
            env,
            coverage: coverage?.reporter,
          })
    // No Jest config at the root, and directories below it with one of their own: one line before
    // the run (an improvement over Jest, which says nothing; DIVERGENCES). Never when stdout is
    // machine output (`--json`, `--debug`; `--listTests` and `--showConfig` end before this), nor
    // under `--collectTests`, which keeps the collector (`reporterResults` is never undefined, so
    // `leadingReporters` would carry the hint), and not for a caller that brings its own reporters.
    const rootHint =
      read.noConfig &&
      request.mode === 'run' &&
      !collecting &&
      !read.globalConfig.json &&
      parsed.argv.debug !== true &&
      io.reporters === undefined
        ? [
            noRootConfigHintReporter({
              rootDir: read.globalConfig.rootDir,
              cwd: realCwd(cwd),
              write: (text) => void stderr.write(text),
            }),
          ]
        : []
    let reporterFailed = false
    const result = await executeProject({
      project,
      onReporterFailures: (failures) => {
        reporterFailed = failures.length > 0
      },
      others,
      // Jest prints a file's path from the working directory (`config.cwd`, the real path of
      // `process.cwd()`, jest-reporters `relativePath`), whatever the config's `rootDir` is.
      root: realCwd(cwd),
      cwd,
      stdout,
      stderr,
      ...(collecting
        ? { reporters: [], collectOnly: true }
        : io.reporters !== undefined
          ? {
              reporters:
                coverage === undefined ? io.reporters : [...io.reporters, coverage.reporter],
            }
          : setup === undefined
            ? {}
            : {
                reporters: setup.reporters,
                text: setup.text,
                announceReporterFailures: setup.announceThrown
                  ? ('thrown' as const)
                  : (false as const),
              }),
      ...(reporterResults === undefined
        ? {}
        : { leadingReporters: [reporterResults.reporter, ...rootHint] }),
      env: io.env ?? process.env,
      display: presentation(
        {
          verbose: setup?.verbose ?? selectedVerbose(read.globalConfig, selectedConfigs),
          globalConfig: read.globalConfig,
        },
        request,
      ),
      pool: poolFor(read.globalConfig, request),
      ...(request.cache === false || !read.cache ? { cache: false } : {}),
      testNamePattern: read.globalConfig.testNamePattern,
      update: request.update,
      ...runSelection,
      // `-i`: the files run in this process. Jest also goes in band by itself for a small run: the
      // policy's `orchestrator.inBand`, decided once the files are known.
      ...(read.globalConfig.runInBand ? { runInBand: true } : {}),
      // The merged global config, not the command line alone: `bail` also comes from the config
      // (and `--bail=2` is false, as in Jest 30.5.2, so a count is always the config's).
      ...(read.globalConfig.bail > 0 ? { bail: { count: read.globalConfig.bail } } : {}),
      ...(read.globalConfig.detectOpenHandles ? { detectOpenHandles: true } : {}),
      // `detectLeaks` is a project key (`--detectLeaks` sets every project's): each project is checked
      // or not by its own, as `runTest` reads `config.detectLeaks`. `--logHeapUsage` is global.
      detectLeaks: (resolved) => selectedConfigs[projects.indexOf(resolved)]?.detectLeaks === true,
      ...(read.globalConfig.logHeapUsage ? { logHeapUsage: true } : {}),
      // Jest's `--shard=i/n` (validated by the config reader, as Jest's `normalize` does).
      ...(shard === undefined ? {} : { shard }),
      ...timingsOf({ timingsFile, updateTimings }),
      // The root config's hooks, which Jest runs beside the projects' own (`runGlobalHook`).
      ...(runHooks === undefined ? {} : { globalSetup: runHooks }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
      ...(coverage === undefined ? {} : { coverage: coverage.hooks }),
    })
    if (read.globalConfig.forceExit) {
      if (!read.globalConfig.detectOpenHandles) stderr.write(`${FORCE_EXIT_WARNING}\n`)
      io.onForceExit?.()
    }
    if (collecting && result.summary !== null && result.summary.files.length === 0) {
      // Jest says so on stdout, whatever `--json` and `--useStderr` say, and writes no results.
      if (result.summary.reason === 'passed' || result.summary.reason === 'failed') {
        await stdout.write('No tests found.\n')
        return ExitCode.Pass
      }
    }
    // Jest processes the results (`processResults`, runJest.ts L173-L213) only when tests ran: with
    // none and no `--passWithNoTests` it prints its message and exits 1 first (L369-L381), and a
    // signal ends the process before it gets there.
    const processing =
      results !== undefined &&
      result.summary !== null &&
      !(result.summary.files.length === 0 && !emptyRunOk) &&
      !results.aggregated().wasInterrupted
    if (results !== undefined && result.summary !== null && processing) {
      results.reportersFailed(reporterFailed || coverage?.reporter.thresholdsFailed() === true)
      if (collecting && !read.globalConfig.json) {
        const style = styleFor({
          env: io.env ?? process.env,
          // chalk 4 follows stdout's terminal, also for what `--useStderr` sends to stderr.
          stream: stdout,
          ci: read.globalConfig.ci,
          colour: request.colour,
        })
        const text = jestCollectedText(results.aggregated(), style)
        if (read.globalConfig.useStderr) stderr.write(text)
        else await stdout.write(text)
      }
      let success: boolean
      try {
        success = await processJestResults({
          aggregated: results.aggregated(),
          globalConfig: read.globalConfig,
          cwd,
          stdout,
          outputStream: read.globalConfig.json || read.globalConfig.useStderr ? stderr : stdout,
          ...(coverage === undefined ? {} : { coverageMap: coverage.reporter.coverageMap() }),
        })
      } catch (error) {
        // A processor that throws (or fails to load) ends Jest's `runCLI` with the error: jest-cli
        // prints its stack and exits 1, whatever the run's own result was.
        stderr.write(`${stackText(error)}\n`)
        return ExitCode.TestFailure
      }
      // Jest ends `success ? 0 : testFailureExitCode` from the processed results; a signal, a
      // usage error or anything else the run decided keeps its own code.
      const failure = read.globalConfig.testFailureExitCode
      if (result.exitCode === ExitCode.Pass || result.exitCode === failure) {
        return success ? ExitCode.Pass : failure
      }
    }
    return result.exitCode
  } catch (error) {
    if (filterError !== undefined && error === filterError) {
      // jest-cli prints the stack of the error that ended `runCLI`, and exits 1.
      stderr.write(`${stackText(error)}\n`)
      return ExitCode.TestFailure
    }
    if (error instanceof JestWatchPluginError) {
      // jest-cli `run.ts` L30-L38: both lines cleared on a terminal, then the error, exit 1.
      for (const stream of [stderr, stdout]) {
        if (Reflect.get(stream, 'isTTY') === true) stream.write(JEST_CLEAR_LINE)
      }
      stderr.write(`${error.message}\n`)
      // Jest exits the process here (`exit(1)`): a plugin built before the failing one may have left
      // a timer or listener open, and nothing tears it down, so the bin ends the process.
      io.onForceExit?.()
      return ExitCode.TestFailure
    }
    if (error instanceof JestNotifierMissingError) {
      // Thrown where Jest builds the NotifyReporter, before a file runs: jest-cli prints the stack
      // of the error that ended `runCLI`, and exits 1.
      stderr.write(`${error.stack ?? error.message}\n`)
      return ExitCode.TestFailure
    }
    if (error instanceof JestConfigError && error.code === 'JEST_CONFIG_RESOLVER_LOAD_FAILED') {
      // jest-resolve's `preloadResolver` lets what the module threw out as it is, and jest-cli
      // prints its stack (`run.ts` L30-L38), exit 1.
      stderr.write(`${stackText(error.cause)}\n`)
      return usage
    }
    if (error instanceof JestCliError || error instanceof JestConfigError) {
      // Jest's own text, as Jest prints it.
      stderr.write(`${error.message}\n`)
      return usage
    }
    const message = usageMessage(error)
    if (message === undefined) throw error
    stderr.write(`${message}\n`)
    return usage
  }
}
