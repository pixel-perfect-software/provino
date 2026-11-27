import { dirname, resolve } from 'node:path'
import {
  ConfigError,
  loadConfigFile,
  type ResolvedCoverage,
  type ResolvedProject,
  resolveProjects,
  withCoverage,
} from '@provino/config'
import {
  discoverProject,
  ExitCode,
  type RunProjectOptions,
  selectFiles,
} from '@provino/orchestrator'
import { isCi } from '@provino/reporters'
import type { FileFilter } from '@provino/types'
import type { RunOptions } from '../types.ts'
import { addOnSpecifier, reportAddOnFailure } from './add-on.ts'
import { builtInDialects, ENVIRONMENTS, NATIVE_RUNTIME } from './built-ins.ts'
import { usageMessage } from './describe.ts'
import { type ExecuteOptions, timingsOf } from './execute.ts'
import { UsageError } from './usage-error.ts'

// What `run()` and the native watch session (`native-watch.ts`) share: loading and resolving the
// config, the options `executeProject` takes from a `RunOptions`, and how a failure is reported.

/**
 * The pool options a run overrides: only the ones given, so the policy's defaults stand. A limit
 * that makes no sense (`workerMemoryLimit`, `maxFilesPerWorker`, `fileTimeoutMs`, `bail`) is the
 * orchestrator's to refuse (`ORCH_BAD_OPTION`, exit 2); `maxWorkers` it would only round. The
 * config's `execArgv` (`configFlags`) goes after the coordinator's own flags, which a fork takes and
 * a thread inherits by default; with none to add the transports keep that default.
 */
function poolOptions(
  options: RunOptions,
  configFlags: readonly string[] = [],
): NonNullable<RunProjectOptions['pool']> {
  if (
    options.maxWorkers !== undefined &&
    (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < 1)
  ) {
    throw new UsageError(
      `maxWorkers must be a whole number of at least 1 (got ${String(options.maxWorkers)})`,
    )
  }
  const { workerMemoryLimit, maxFilesPerWorker, fileTimeoutMs } = options
  return {
    ...(options.pool === undefined ? {} : { kind: options.pool }),
    ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
    ...(fileTimeoutMs === undefined ? {} : { fileTimeoutMs }),
    ...(workerMemoryLimit === undefined && maxFilesPerWorker === undefined
      ? {}
      : {
          recycle: {
            ...(workerMemoryLimit === undefined ? {} : { memoryLimitBytes: workerMemoryLimit }),
            ...(maxFilesPerWorker === undefined ? {} : { maxFilesPerWorker }),
          },
        }),
    ...(configFlags.length === 0 ? {} : { execArgv: [...process.execArgv, ...configFlags] }),
  }
}

/**
 * What a run needs of its config before it starts: the resolved projects, the pool the command line
 * and the config ask for, the environment and the config's path. `run()` and the native watch session
 * (`internal/native-watch.ts`) share it.
 * @internal
 */
export interface ResolvedRun {
  /** The projects as the config resolved them: `coveredRun` adds the worker config for coverage. */
  readonly project: ResolvedProject
  readonly others: readonly ResolvedProject[]
  readonly root: string | undefined
  readonly cwd: string
  /** The config file's absolute path. */
  readonly configPath: string
  readonly env: NonNullable<RunOptions['env']>
  readonly pool: NonNullable<RunProjectOptions['pool']>
  /** The config's `uniqueFiles`: no file may belong to two projects. */
  readonly uniqueFiles: boolean
  /** The config's `coverage` key with its defaults applied (`enabled` is the config's own say). */
  readonly coverage: ResolvedCoverage
}

/**
 * Loads `options.config` and resolves its projects. Bad input is a `UsageError` or a
 * `ConfigError`, which `reportRunError` says.
 * @internal
 */
export async function resolveRun(options: RunOptions): Promise<ResolvedRun> {
  if (typeof options.config !== 'string' || options.config === '') {
    throw new UsageError('run() needs the path of a config file')
  }
  poolOptions(options)
  const cwd = resolve(options.cwd ?? process.cwd())

  // The composition root resolves the environment once; everything below reads this.
  const env = options.env ?? process.env
  const configPath = resolve(cwd, options.config)
  const input = await loadConfigFile(configPath, { command: 'run', mode: 'test' })
  // The Jest add-on (D187) resolves from the config's directory, for this call only.
  const root = dirname(configPath)
  const resolved = await resolveProjects(input, {
    configPath,
    dialects: [],
    loadDialects: () => builtInDialects(root),
    environments: ENVIRONMENTS,
    ci: options.ci ?? isCi(env),
    native: NATIVE_RUNTIME,
  }).catch(async (error: unknown) => {
    // A config that names `dialect: 'jest'` or holds a `jest` key, refused because the add-on gave
    // no dialect: the add-on's own failure (not installed, or of another provino) says why. Any
    // other error (a typo'd key among them) is the config's own.
    if (error instanceof ConfigError && error.subject === 'jest') {
      await import(addOnSpecifier('jest', '', root))
    }
    throw error
  })
  const [project, ...others] = resolved.projects
  if (project === undefined) throw new UsageError('the config has no project to run')
  // The command line wins over the config's own defaults.
  const pool = poolOptions(
    {
      ...options,
      ...(options.pool === undefined && resolved.pool !== undefined ? { pool: resolved.pool } : {}),
      ...(options.maxWorkers === undefined && resolved.maxWorkers !== undefined
        ? { maxWorkers: resolved.maxWorkers }
        : {}),
    },
    resolved.execArgv,
  )
  return {
    project,
    others,
    root: resolved.root,
    cwd,
    configPath,
    env,
    pool,
    uniqueFiles: resolved.uniqueFiles,
    coverage: resolved.coverage,
  }
}

/**
 * `resolved` for a run that collects coverage (`--coverage` or `coverage.enabled`): its projects
 * carry the worker config for it. A watch session collects none.
 * @internal
 */
export function coveredRun(resolved: ResolvedRun): ResolvedRun {
  const { coverage, configPath } = resolved
  const [project = resolved.project, ...others] = withCoverage(
    [resolved.project, ...resolved.others],
    coverage,
    coverage.root,
    configPath,
  )
  return { ...resolved, project, others }
}

/**
 * The command line's test path patterns as file filters of kind `regex`: Jest's `testPathPatterns`,
 * case-insensitive over the path (an invalid one is the orchestrator's `ORCH_BAD_PATTERN`, exit 2).
 * @internal
 */
export function patternFilters(patterns: readonly string[] | undefined): readonly FileFilter[] {
  return (patterns ?? []).map((value) => ({ kind: 'regex', value }))
}

/**
 * The files of `project` (as `discoverProject` found them) that `filters` keep: Jest's
 * `testPathPatterns`, against the project's root and the run's working directory.
 * @internal
 */
export function selectByPatterns(
  files: Parameters<typeof selectFiles>[0],
  filters: readonly FileFilter[],
  project: ResolvedProject,
  cwd: string,
): ReturnType<typeof selectFiles> {
  return selectFiles(files, filters, { rootDir: project.rootDir, cwd })
}

/** Said when test path patterns kept no file, so a mistyped one (or a mistyped command) reads clearly. */
export function noMatchLine(patterns: readonly string[]): string {
  const named = patterns.map((pattern) => JSON.stringify(pattern)).join(', ')
  return `Provino: no test file matches ${patterns.length === 1 ? 'the pattern' : 'any of the patterns'} ${named}\n`
}

/**
 * Whether the command line's patterns select no file at all in any project: the only case the
 * no-match line is for. A shard that got none, or a run cut short before a file was queued, has
 * files the patterns select, so neither says it.
 * @internal
 */
export async function patternsSelectNothing(
  options: RunOptions,
  resolved: ResolvedRun,
): Promise<boolean> {
  const filters = patternFilters(options.testPathPatterns)
  if (filters.length === 0) return false
  for (const project of [resolved.project, ...resolved.others]) {
    const files = await discoverProject(project)
    if (selectByPatterns(files, filters, project, resolved.cwd).length > 0) return false
  }
  return true
}

/** Says (once) that the command line's patterns select no file, when none of the projects has one. */
export async function reportNoMatch(
  options: RunOptions,
  resolved: ResolvedRun,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  if (await patternsSelectNothing(options, resolved)) {
    stderr.write(noMatchLine(options.testPathPatterns ?? []))
  }
}

/**
 * What `run()` and a watch run both hand `executeProject`: the project, where output goes, the
 * reporters, the pool and every run option `options` carries. A watch run adds its session and
 * its own `passWithNoTests` on top.
 * @internal
 */
export function executeOptionsOf(
  options: RunOptions,
  resolved: ResolvedRun,
  stdout: NonNullable<RunOptions['stdout']>,
  stderr: NonNullable<RunOptions['stderr']>,
): ExecuteOptions {
  const { project, others, root, cwd, env, pool, uniqueFiles } = resolved
  const fileFilters = patternFilters(options.testPathPatterns)
  return {
    project,
    ...(others.length === 0 ? {} : { others }),
    ...(root === undefined ? {} : { root }),
    ...(uniqueFiles ? { uniqueFiles: true } : {}),
    cwd,
    stdout,
    stderr,
    reporters: options.reporters,
    env,
    ...(options.emoji === false ? { display: { emoji: false } } : {}),
    ...(options.views === undefined ? {} : { views: options.views }),
    // Jest's single-file rule decides between `provino` and a listing of the one file's tests
    // (`selectsProvino`), so the reporters may need the count before the run: asked only then. A
    // sharded run's count is the shard's, which only the run knows; it is left to the run.
    ...(options.shard === undefined && others.length === 0
      ? {
          fileCount: async () =>
            selectByPatterns(await discoverProject(project), fileFilters, project, cwd).length,
        }
      : {}),
    ...(fileFilters.length === 0 ? {} : { fileFilters }),
    pool,
    ...(options.cache === false ? { cache: false } : {}),
    testNamePattern: options.testNamePattern,
    update: options.updateSnapshot,
    passWithNoTests: options.passWithNoTests,
    signal: options.signal,
    forceSignal: options.forceSignal,
    ...(options.bail === undefined || options.bail === 0 ? {} : { bail: { count: options.bail } }),
    ...(options.detectOpenHandles === true ? { detectOpenHandles: true } : {}),
    ...(options.shard === undefined ? {} : { shard: options.shard }),
    ...timingsOf(options),
  }
}

/**
 * Says what a failed run was: the exit code for an add-on that is not there (1) or bad input
 * (2), after printing the message to `stderr`; `undefined` for any other error, which is a bug.
 * @internal
 */
export function reportRunError(error: unknown, stderr: NodeJS.WritableStream): number | undefined {
  // Exit 1, as `provino jest` without the add-on: an install to fix, not a command-line mistake.
  const addOn = reportAddOnFailure(error, stderr)
  if (addOn !== undefined) return addOn
  const message = usageMessage(error)
  if (message === undefined) return undefined
  stderr.write(`${message}\n`)
  return ExitCode.UsageError
}
