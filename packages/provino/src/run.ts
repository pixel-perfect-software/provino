import { executeProject } from './internal/execute.ts'
import { executeOptionsOf, reportRunError, resolveRun } from './internal/run-setup.ts'
import type { RunOptions, RunResult } from './types.ts'

async function execute(
  options: RunOptions,
  stdout: NonNullable<RunOptions['stdout']>,
  stderr: NonNullable<RunOptions['stderr']>,
): Promise<RunResult> {
  return executeProject(executeOptionsOf(options, await resolveRun(options), stdout, stderr))
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
    const exitCode = reportRunError(error, stderr)
    if (exitCode === undefined) throw error
    return { exitCode, summary: null }
  }
}
