import { resolve } from 'node:path'
import { loadProject } from '@provino/config'
import { jestDialect } from '@provino/dialect-jest'
import { ExitCode, exitCodeFor, type RunProjectOptions, runProject } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import { isCi } from './internal/ci.ts'
import { usageMessage } from './internal/describe.ts'
import { reportersFor } from './internal/reporters.ts'
import { UsageError } from './internal/usage-error.ts'
import type { RunOptions, RunResult } from './types.ts'

/** The pool options a run overrides: only the ones given, so the policy's defaults stand. */
function poolOptions(options: RunOptions): NonNullable<RunProjectOptions['pool']> {
  if (
    options.maxWorkers !== undefined &&
    (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < 1)
  ) {
    throw new UsageError(
      `maxWorkers must be a whole number of at least 1 (got ${String(options.maxWorkers)})`,
    )
  }
  return {
    ...(options.pool === undefined ? {} : { kind: options.pool }),
    ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
  }
}

async function execute(
  options: RunOptions,
  stdout: NonNullable<RunOptions['stdout']>,
  stderr: NonNullable<RunOptions['stderr']>,
): Promise<RunResult> {
  if (typeof options.config !== 'string' || options.config === '') {
    throw new UsageError('run() needs the path of a config file')
  }
  const pool = poolOptions(options)
  const cwd = resolve(options.cwd ?? process.cwd())

  const project = await loadProject(resolve(cwd, options.config), {
    dialects: [jestDialect],
    environments: {
      node: { module: import.meta.resolve('@provino/env-node'), export: 'nodeEnvironment' },
    },
    ci: options.ci ?? isCi(process.env),
  })
  const bus = createReporterBus(reportersFor(options.reporters, { project, cwd, stdout, stderr }))

  const summary = await runProject(project, {
    bus,
    pool,
    // Jest writes all test output to stderr and keeps stdout for `--json`: a worker's own stdout
    // (a direct write to fd 1) goes there too, so it can't land in the middle of a reporter's.
    stdout: stderr,
    stderr,
    // Omitted, `runProject` keeps the cache in the project's `node_modules/.cache/provino`.
    ...(options.cache === false ? { cache: false } : {}),
    ...(options.testNamePattern === undefined ? {} : { testNamePattern: options.testNamePattern }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  // A reporter that failed (a JSON file that couldn't be written) fails the run. The default
  // reporter shows such an error itself; the others may not, so it is said here as well.
  const reporterFailures = bus.failures()
  for (const failure of reporterFailures) {
    stderr.write(`Provino: a reporter failed: ${failure.message}\n`)
  }
  return {
    exitCode: exitCodeFor(summary, {
      policy: project.policy,
      reporterFailures,
      ...(options.passWithNoTests === undefined
        ? {}
        : { passWithNoTests: options.passWithNoTests }),
    }),
    summary,
  }
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
 * or reporter that makes no sense, a test name pattern that isn't a regular expression) does not
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
    const message = usageMessage(error)
    if (message === undefined) throw error
    stderr.write(`${message}\n`)
    return { exitCode: ExitCode.UsageError, summary: null }
  }
}
