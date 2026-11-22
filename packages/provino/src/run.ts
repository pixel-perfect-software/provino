import { resolve } from 'node:path'
import { ConfigError, loadConfigFile, resolveProjects } from '@provino/config'
import { discoverProject, ExitCode, type RunProjectOptions } from '@provino/orchestrator'
import { isCi } from '@provino/reporters'
import { addOnFailure, DialectNotInstalledError, resolveAddOnsFrom } from './internal/add-on.ts'
import { builtInDialects, ENVIRONMENTS, NATIVE_RUNTIME } from './internal/built-ins.ts'
import { usageMessage } from './internal/describe.ts'
import { executeProject, timingsOf } from './internal/execute.ts'
import { UsageError } from './internal/usage-error.ts'
import type { RunOptions, RunResult } from './types.ts'

/**
 * The pool options a run overrides: only the ones given, so the policy's defaults stand. A limit
 * that makes no sense (`workerMemoryLimit`, `maxFilesPerWorker`, `fileTimeoutMs`, `bail`) is the
 * orchestrator's to refuse (`ORCH_BAD_OPTION`, exit 2); `maxWorkers` it would only round.
 */
function poolOptions(options: RunOptions): NonNullable<RunProjectOptions['pool']> {
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
  }
}

/** Whether `error` is `@provino/config`'s refusal of the Jest dialect by name or of its `jest` key. */
function namesJestDialect(error: unknown): boolean {
  if (!(error instanceof ConfigError)) return false
  if (error.code === 'CONFIG_UNKNOWN_DIALECT')
    return error.message.startsWith('unknown dialect "jest"')
  return error.code === 'CONFIG_UNKNOWN_KEY' && /\bkey "jest"/.test(error.message)
}

async function execute(
  options: RunOptions,
  stdout: NonNullable<RunOptions['stdout']>,
  stderr: NonNullable<RunOptions['stderr']>,
): Promise<RunResult> {
  if (typeof options.config !== 'string' || options.config === '') {
    throw new UsageError('run() needs the path of a config file')
  }
  poolOptions(options)
  const cwd = resolve(options.cwd ?? process.cwd())

  // The composition root resolves the environment once; everything below reads this.
  const env = options.env ?? process.env
  const configPath = resolve(cwd, options.config)
  // The add-ons (D187) resolve from the project: `provino/jest` in a config file included.
  resolveAddOnsFrom(cwd)
  const input = await loadConfigFile(configPath, { command: 'run', mode: 'test' })
  const dialects = builtInDialects()
  const resolved = await resolveProjects(input, {
    configPath,
    dialects: [],
    loadDialects: dialects.load,
    environments: ENVIRONMENTS,
    ci: options.ci ?? isCi(env),
    native: NATIVE_RUNTIME,
  }).catch((error: unknown) => {
    // Without the Jest add-on a config that names `dialect: 'jest'` or holds a `jest` key is the
    // install line; any other error (a typo'd key among them) is the config's own.
    if (dialects.missing() && namesJestDialect(error)) throw new DialectNotInstalledError('jest')
    throw error
  })
  const [project, ...others] = resolved.projects
  if (project === undefined) throw new UsageError('the config has no project to run')
  // The command line wins over the config's own defaults.
  const pool = poolOptions({
    ...options,
    ...(options.pool === undefined && resolved.pool !== undefined ? { pool: resolved.pool } : {}),
    ...(options.maxWorkers === undefined && resolved.maxWorkers !== undefined
      ? { maxWorkers: resolved.maxWorkers }
      : {}),
  })
  return executeProject({
    project,
    ...(others.length === 0 ? {} : { others }),
    ...(resolved.root === undefined ? {} : { root: resolved.root }),
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
      ? { fileCount: async () => (await discoverProject(project)).length }
      : {}),
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
  })
}

/**
 * Runs a project's tests, as `provino run` does, and resolves with the exit code the run calls for
 * and its summary. Nothing here exits the process or keeps state between calls: the worker pool
 * and the results cache belong to one call, so calls can follow each other or overlap (on
 * different projects).
 *
 * The config file is loaded, the Jest dialect and the Node environment are the built-ins it can
 * name, and every reporter is built from `reporters` or the policy's defaults. Bad input (no
 * config file, a config that doesn't load or fails its checks, an unknown dialect, a `maxWorkers`
 * or reporter that makes no sense, a `bail` that isn't a whole number of at least 0, a test name
 * pattern that isn't a regular expression, a limit the orchestrator refuses) does not
 * reject: the message goes to `stderr` and the result is exit code 2 with a `null` summary. Any
 * other error is a bug and rejects.
 * @public
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  try {
    return await execute(options, stdout, stderr)
  } catch (error) {
    const missing = addOnFailure(error)
    if (missing !== undefined) {
      stderr.write(`Provino: ${missing.message}\n`)
      // Exit 1, as `provino jest` without the add-on: an install to fix, not a command-line mistake.
      return { exitCode: ExitCode.TestFailure, summary: null }
    }
    const message = usageMessage(error)
    if (message === undefined) throw error
    stderr.write(`${message}\n`)
    return { exitCode: ExitCode.UsageError, summary: null }
  }
}
