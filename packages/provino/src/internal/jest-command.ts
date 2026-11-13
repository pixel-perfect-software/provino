// `provino jest <jest arguments>` (T11.13, U3): the Jest command line, parsed by the Jest dialect's
// own parser, layered over the project Jest's config reader finds, run by the same coordinator
// as `provino run`, and ended with Jest's exit codes.
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { type ResolvedProject, resolveNeutralProject } from '@provino/config'
import {
  createJestConfigReader,
  createJestResults,
  type JestArgv,
  JestCliError,
  JestConfigError,
  type JestGlobalConfig,
  type JestProjectConfig,
  jestCli,
  jestCollectedText,
  jestNodeDialect,
  jestRunGlobalHooks,
  processJestResults,
} from '@provino/dialect-jest/node'
import {
  defaultCacheDir,
  discoverProject,
  ExitCode,
  isProvinoCacheDir,
  readTimings,
  type ShardSpec,
  selectFiles,
  shardFiles,
  TIMINGS_FILE_NAME,
} from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { ConfigSource, Diagnostic, NeutralProject, RunRequest } from '@provino/types'
import type { ReporterChoice } from '../types.ts'
import { JEST_BUILT_INS, JEST_ENVIRONMENT, NODE_ENVIRONMENT } from './built-ins.ts'
import { usageMessage } from './describe.ts'
import { executeProject, timingsOf } from './execute.ts'
import { setUpJestReporters } from './jest-reporters.ts'
import { type DisplayOptions, outputFor, styleFor } from './reporters.ts'
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
}> {
  const reader = createJestConfigReader({ argv, cwd })
  // No config file: Jest runs with its defaults over the working directory.
  const source: ConfigSource = (await reader.find(cwd, request.configPath)) ?? {
    kind: 'inline',
    path: cwd,
    text: '{}',
  }
  const raw = await reader.load(source)
  const resolved = await reader.resolve(raw, source)
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

/** Every project's test files, once each, sorted by path; only shard `sharding.shard`'s when it names one. */
async function listFiles(
  projects: readonly ResolvedProject[],
  request: RunRequest,
  cwd: string,
  sharding: ShardRequest & { readonly runRoot: string },
): Promise<readonly string[]> {
  const selected = await Promise.all(
    projects.map(async (project) =>
      selectFiles(await discoverProject(project), request.fileFilters, {
        rootDir: project.rootDir,
        cwd,
      }),
    ),
  )
  const [first] = projects
  const { shard } = sharding
  const perProject =
    shard === undefined || first === undefined
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
  return [...new Set(perProject.flatMap((files) => files.map((file) => file.path)))].sort()
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
  try {
    const { rest, timingsFile, updateTimings } = takeTimingsFlags(args)
    const parsed = jestCli.parse(rest)
    if (report(parsed.diagnostics, stderr)) return usage
    const request = jestCli.toRunRequest(parsed.argv)
    const read = await readProjects(parsed.argv, request, cwd)
    if (report(read.diagnostics, stderr)) return usage

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
    if (request.mode === 'list-files') {
      const sharding = {
        shard: shardOf(read.globalConfig),
        timingsFile,
        runRoot: read.globalConfig.rootDir,
      }
      const files = await listFiles(projects, request, cwd, sharding)
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
        projectConfigs: neutrals.flatMap((neutral) => {
          const config = read.configs[read.neutral.indexOf(neutral)]
          return config === undefined ? [] : [config]
        }),
      })
    const results =
      collecting || read.globalConfig.json || read.globalConfig.testResultsProcessor !== undefined
        ? newResults()
        : undefined
    // The reporters (Jest's failure text, the classes a config names) read the same results; a run
    // that neither writes JSON nor runs a processor keeps its own exit code.
    const reporterResults = results ?? (collecting ? undefined : newResults())
    const env = io.env ?? process.env
    const setup =
      collecting || io.reporters !== undefined || reporterResults === undefined
        ? undefined
        : await setUpJestReporters({
            globalConfig: read.globalConfig,
            configs: read.configs,
            results: reporterResults,
            output: outputFor({ env, stderr, ci: read.globalConfig.ci, colour: request.colour }),
            env,
          })
    let reporterFailed = false
    const result = await executeProject({
      project,
      onReporterFailures: (failures) => {
        reporterFailed = failures.length > 0
      },
      others,
      root: read.globalConfig.rootDir,
      cwd,
      stdout,
      stderr,
      ...(collecting
        ? { reporters: [], collectOnly: true }
        : io.reporters !== undefined
          ? { reporters: io.reporters }
          : setup === undefined
            ? {}
            : {
                reporters: setup.reporters,
                text: setup.text,
                announceReporterFailures: false as const,
              }),
      ...(reporterResults === undefined ? {} : { leadingReporters: [reporterResults.reporter] }),
      env: io.env ?? process.env,
      display: presentation(read, request),
      pool: {
        ...(request.workerThreads === true ? { kind: 'threads' as const } : {}),
        maxWorkers: read.globalConfig.maxWorkers,
        ...workerRecycle(read.globalConfig.workerIdleMemoryLimit),
      },
      ...(request.cache === false || !read.cache ? { cache: false } : {}),
      testNamePattern: read.globalConfig.testNamePattern,
      update: request.update,
      fileFilters: request.fileFilters,
      // The merged global config, not the command line alone: `bail` also comes from the config
      // (and `--bail=2` is false, as in Jest 30.5.2, so a count is always the config's).
      ...(read.globalConfig.bail > 0 ? { bail: { count: read.globalConfig.bail } } : {}),
      ...(read.globalConfig.detectOpenHandles ? { detectOpenHandles: true } : {}),
      // Jest's `--shard=i/n` (validated by the config reader, as Jest's `normalize` does).
      ...(shard === undefined ? {} : { shard }),
      ...timingsOf({ timingsFile, updateTimings }),
      // The root config's hooks, which Jest runs beside the projects' own (`runGlobalHook`).
      ...(runHooks === undefined ? {} : { globalSetup: runHooks }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
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
      !(result.summary.files.length === 0 && !read.globalConfig.passWithNoTests) &&
      !results.aggregated().wasInterrupted
    if (results !== undefined && result.summary !== null && processing) {
      results.reportersFailed(reporterFailed)
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
        })
      } catch (error) {
        // A processor that throws (or fails to load) ends Jest's `runCLI` with the error: jest-cli
        // prints its stack and exits 1, whatever the run's own result was.
        stderr.write(`${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`)
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
