import type { ExecuteOptions } from './internal/execute.ts'
import { executeProject } from './internal/execute.ts'
import {
  executeOptionsOf,
  noMatchLine,
  patternsSelectNothing,
  type ResolvedRun,
  reportRunError,
  resolveRun,
} from './internal/run-setup.ts'
import type { RunOptions, RunResult } from './types.ts'

/** `executeProject`, then the no-match line when the patterns themselves selected no file. */
async function executeProjectNamingPatterns(
  options: RunOptions,
  resolved: ResolvedRun,
  execute: ExecuteOptions,
  stderr: NonNullable<RunOptions['stderr']>,
): Promise<RunResult> {
  const result = await executeProject(execute)
  // Only a run with no file asks: a shard or an interrupt can leave none while the patterns matched.
  if (result.summary?.files.length === 0 && (await patternsSelectNothing(options, resolved))) {
    stderr.write(noMatchLine(options.testPathPatterns ?? []))
  }
  return result
}

async function execute(
  options: RunOptions,
  stdout: NonNullable<RunOptions['stdout']>,
  stderr: NonNullable<RunOptions['stderr']>,
): Promise<RunResult> {
  const resolved = await resolveRun(options)
  const base: ExecuteOptions = executeOptionsOf(options, resolved, stdout, stderr)
  if (!resolved.collectCoverage)
    return executeProjectNamingPatterns(options, resolved, base, stderr)
  // The coverage reporter brings `@provino/coverage/node`: loaded only for a run that collects (T1.10).
  const { nativeCoverageFor } = await import('./internal/native-coverage.ts')
  const coverage = nativeCoverageFor(resolved, {
    stdout,
    stderr,
    ci: resolved.project.config.ci,
    passWithNoTests: options.passWithNoTests,
  })
  const result = await executeProjectNamingPatterns(
    options,
    resolved,
    {
      ...base,
      // Before the text reporters, so the table and the threshold lines come ahead of the summary.
      leadingReporters: [coverage.reporter],
      coverage: coverage.hooks,
    },
    stderr,
  )
  // Reports that could not be written fail a run that would otherwise pass.
  return result.exitCode === 0 && coverage.reporter.reportsFailed()
    ? { ...result, exitCode: resolved.project.policy.orchestrator.exitCodes.failure }
    : result
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
