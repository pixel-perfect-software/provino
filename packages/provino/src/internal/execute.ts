import type { ResolvedProject } from '@provino/config'
import { exitCodeFor, type RunProjectOptions, runProjects } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { FileFilter } from '@provino/types'
import type { ReporterChoice, RunOptions, RunResult } from '../types.ts'
import { reportersFor } from './reporters.ts'

/**
 * What a run of an already-resolved project needs: the part of a run that `run()` (a
 * `provino.config.*` project) and `provino jest` (a Jest project) share.
 * @internal
 */
export interface ExecuteOptions {
  /** The project, or the first of several (it decides the reporters, the exit policy and the pool kind). */
  readonly project: ResolvedProject
  /** The other projects of a multi-project run (Jest's `projects`, D29), after `project`. */
  readonly others?: readonly ResolvedProject[]
  /** The run's own root, when it isn't `project`'s (a multi-project config's `rootDir`). */
  readonly root?: string
  readonly cwd: string
  readonly stdout: NonNullable<RunOptions['stdout']>
  readonly stderr: NonNullable<RunOptions['stderr']>
  readonly reporters?: readonly ReporterChoice[] | undefined
  readonly pool: NonNullable<RunProjectOptions['pool']>
  /** `false`: neither read nor write the results cache. */
  readonly cache?: false
  readonly testNamePattern?: string | undefined
  /** Rewrite the snapshots that differ (`-u`). */
  readonly update?: boolean | undefined
  readonly fileFilters?: readonly FileFilter[]
  readonly passWithNoTests?: boolean | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * Runs a resolved project, or several through one pool: the reporters and their bus, `runProject`, and the exit code the
 * summary and the reporters' failures call for.
 * @internal
 */
export async function executeProject(options: ExecuteOptions): Promise<RunResult> {
  const { project, cwd, stdout, stderr } = options
  const bus = createReporterBus(reportersFor(options.reporters, { project, cwd, stdout, stderr }))

  const summary = await runProjects([project, ...(options.others ?? [])], {
    ...(options.root === undefined ? {} : { root: options.root }),
    bus,
    pool: options.pool,
    // Jest writes all test output to stderr and keeps stdout for `--json`: a worker's own stdout
    // (a direct write to fd 1) goes there too, so it can't land in the middle of a reporter's.
    stdout: stderr,
    stderr,
    cwd,
    // Omitted, `runProject` keeps the cache in the project's `node_modules/.cache/provino`.
    ...(options.cache === false ? { cache: false } : {}),
    ...(options.testNamePattern === undefined ? {} : { testNamePattern: options.testNamePattern }),
    ...(options.update === true ? { update: true } : {}),
    ...(options.fileFilters === undefined ? {} : { fileFilters: options.fileFilters }),
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
