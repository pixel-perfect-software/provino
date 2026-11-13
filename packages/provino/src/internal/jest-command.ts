// `provino jest <jest arguments>` (T11.13, U3): the Jest command line, parsed by the Jest dialect's
// own parser, layered over the project Jest's config reader finds, run by the same coordinator
// as `provino run`, and ended with Jest's exit codes.
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type ResolvedProject, resolveNeutralProject } from '@provino/config'
import {
  createJestConfigReader,
  type JestArgv,
  JestCliError,
  JestConfigError,
  type JestGlobalConfig,
  jestCli,
  jestNodeDialect,
} from '@provino/dialect-jest/node'
import {
  defaultCacheDir,
  discoverProject,
  ExitCode,
  isProvinoCacheDir,
  selectFiles,
} from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { ConfigSource, Diagnostic, NeutralProject, RunRequest } from '@provino/types'
import type { ReporterChoice } from '../types.ts'
import { JEST_BUILT_INS, JEST_ENVIRONMENT, NODE_ENVIRONMENT } from './built-ins.ts'
import { usageMessage } from './describe.ts'
import { executeProject } from './execute.ts'
import type { DisplayOptions } from './reporters.ts'
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
 * or any project), `silent`, `expand` and `noStackTrace` from the merged global config, and the
 * colour request from `--color`, `--colors` and `--no-color`.
 */
function presentation(
  read: { readonly verbose: boolean; readonly globalConfig: JestGlobalConfig },
  request: RunRequest,
): DisplayOptions {
  const { globalConfig } = read
  return {
    ...(read.verbose ? { verbose: true } : {}),
    ...(globalConfig.silent === true ? { silent: true } : {}),
    ...(globalConfig.expand ? { expand: true } : {}),
    ...(globalConfig.noStackTrace ? { noStackTrace: true } : {}),
    ...(request.colour === undefined ? {} : { colour: request.colour }),
  }
}

/** The projects of the config the request names (or the one found from `cwd`), unresolved. */
async function readProjects(
  argv: JestArgv,
  request: RunRequest,
  cwd: string,
): Promise<{
  readonly neutral: readonly NeutralProject[]
  readonly globalConfig: JestGlobalConfig
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
    cache: resolved.value.configs.every((config) => config.cache),
    verbose:
      resolved.value.globalConfig.verbose === true ||
      resolved.value.configs.some((config) => config.verbose === true),
    showable: { globalConfig: resolved.value.globalConfig, configs: resolved.value.configs },
    diagnostics: [...resolved.diagnostics, ...neutral.diagnostics],
  }
}

/** Every project's test files, once each, sorted by path. */
async function listFiles(
  projects: readonly ResolvedProject[],
  request: RunRequest,
  cwd: string,
): Promise<readonly string[]> {
  const perProject = await Promise.all(
    projects.map(async (project) =>
      selectFiles(await discoverProject(project), request.fileFilters, {
        rootDir: project.rootDir,
        cwd,
      }),
    ),
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
    const parsed = jestCli.parse(args)
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
      const files = await listFiles(projects, request, cwd)
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
    const result = await executeProject({
      project,
      others,
      root: read.globalConfig.rootDir,
      cwd,
      stdout,
      stderr,
      ...(io.reporters === undefined ? {} : { reporters: io.reporters }),
      ...(io.env === undefined ? {} : { env: io.env }),
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
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
    })
    if (read.globalConfig.forceExit) {
      if (!read.globalConfig.detectOpenHandles) stderr.write(`${FORCE_EXIT_WARNING}\n`)
      io.onForceExit?.()
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
