import type { ResolvedProject } from '@provino/config'
import {
  exitCodeFor,
  hookFailureReport,
  OrchestratorError,
  type RunGlobalHooks,
  type RunProjectOptions,
  runProjects,
  type ShardSpec,
} from '@provino/orchestrator'
import { createReporterBus, type Environment } from '@provino/reporters'
import type { FileFilter, Reporter, ReporterBus, RunSummary } from '@provino/types'
import type { ReporterChoice, RunOptions, RunResult } from '../types.ts'
import { workerStartupEnv } from './compile-cache.ts'
import { type DisplayOptions, reportersFor, type TextExtras } from './reporters.ts'

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
  /** Reporters that hear every event before the others (a result collector), whatever `reporters` says. */
  readonly leadingReporters?: readonly Reporter[]
  /** What the reporters read for the terminal, CI, an agent and colour: resolved by the caller. */
  readonly env: Environment
  /** How text looks (Jest's `--verbose`, `--silent`, `--expand`, `--noStackTrace`, `--colors`). */
  readonly display?: DisplayOptions
  /** What a dialect adds to the text reporters (its failure text, a summary of its own). */
  readonly text?: TextExtras
  /** `false`: a reporter that failed is not announced on stderr (Jest prints nothing for `getLastError`); the run still fails. */
  readonly announceReporterFailures?: false
  readonly pool: NonNullable<RunProjectOptions['pool']>
  /** `false`: neither read nor write the results cache. */
  readonly cache?: false
  readonly testNamePattern?: string | undefined
  /** Collect each file and report what its tests would do, running none (`--collectTests`). */
  readonly collectOnly?: boolean
  /** Rewrite the snapshots that differ (`-u`). */
  readonly update?: boolean | undefined
  readonly fileFilters?: readonly FileFilter[]
  readonly passWithNoTests?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  /** The second Ctrl+C: kills the workers at once. */
  readonly forceSignal?: AbortSignal | undefined
  /** End the run once this many tests have failed. */
  readonly bail?: { readonly count: number }
  /** Report the handles still open after the run; runs in band. */
  readonly detectOpenHandles?: boolean
  /** The run's own global hooks (Jest's root `globalSetup` and `globalTeardown`). */
  readonly globalSetup?: RunGlobalHooks
  /** Run only this shard of the files (`--shard`, 1-based). */
  readonly shard?: ShardSpec
  /** The timings file `shard` cuts by, and whether the run writes it (`--update-timings`). */
  readonly timings?: NonNullable<RunProjectOptions['timings']>
}

/**
 * The `timings` run option from a timings file and `--update-timings`: only what was given.
 * @internal
 */
export function timingsOf(options: {
  readonly timingsFile?: string | undefined
  readonly updateTimings?: boolean | undefined
}): Pick<ExecuteOptions, 'timings'> {
  if (options.timingsFile === undefined && options.updateTimings !== true) return {}
  return {
    timings: {
      ...(options.timingsFile === undefined ? {} : { file: options.timingsFile }),
      ...(options.updateTimings === true ? { update: true } : {}),
    },
  }
}

/**
 * Runs a resolved project, or several through one pool: the reporters and their bus, `runProject`, and the exit code the
 * summary and the reporters' failures call for.
 * @internal
 */
export async function executeProject(options: ExecuteOptions): Promise<RunResult> {
  const { project, cwd, stdout, stderr } = options
  const bus = createReporterBus([
    ...(options.leadingReporters ?? []),
    ...reportersFor(options.reporters, {
      project,
      cwd,
      stdout,
      stderr,
      env: options.env,
      ...(options.display === undefined ? {} : { display: options.display }),
      ...(options.text === undefined ? {} : { text: options.text }),
    }),
  ])

  let summary: RunSummary
  try {
    summary = await run(options, bus, [project, ...(options.others ?? [])])
  } catch (error) {
    if (!(error instanceof OrchestratorError) || error.code !== 'ORCH_GLOBAL_SETUP_FAILED') {
      throw error
    }
    // A global setup or teardown that threw: the user's error, said as Jest says it (the error's
    // own class and text, then the frames of what the hook threw), with the runner's failure exit
    // code.
    stderr.write(hookFailureReport(error))
    return { exitCode: project.policy.orchestrator.exitCodes.failure, summary: null }
  }

  // A reporter that failed (a JSON file that couldn't be written) fails the run. The default
  // reporter shows such an error itself; the others may not, so it is said here as well.
  const reporterFailures = bus.failures()
  if (options.announceReporterFailures !== false) {
    for (const failure of reporterFailures) {
      stderr.write(`Provino: a reporter failed: ${failure.message}\n`)
    }
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

function run(
  options: ExecuteOptions,
  bus: ReporterBus,
  projects: readonly ResolvedProject[],
): Promise<RunSummary> {
  const { stderr, cwd } = options
  // The bin's compile cache for the forked workers' own startup, and for them only (see
  // `workerStartupEnv`); `{}` for a library caller, which turned nothing on.
  const startupEnv = workerStartupEnv(process.env)
  return runProjects(projects, {
    ...(options.root === undefined ? {} : { root: options.root }),
    bus,
    pool: Object.keys(startupEnv).length === 0 ? options.pool : { ...options.pool, startupEnv },
    // Jest writes all test output to stderr and keeps stdout for `--json`: a worker's own stdout
    // (a direct write to fd 1) goes there too, so it can't land in the middle of a reporter's.
    stdout: stderr,
    stderr,
    cwd,
    // Omitted, `runProject` keeps the cache in the project's `node_modules/.cache/provino`.
    ...(options.cache === false ? { cache: false } : {}),
    ...(options.testNamePattern === undefined ? {} : { testNamePattern: options.testNamePattern }),
    ...(options.update === true ? { update: true } : {}),
    ...(options.collectOnly === true ? { collectOnly: true } : {}),
    ...(options.fileFilters === undefined ? {} : { fileFilters: options.fileFilters }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.forceSignal === undefined ? {} : { forceSignal: options.forceSignal }),
    ...(options.bail === undefined ? {} : { bail: options.bail }),
    ...(options.detectOpenHandles === true ? { detectOpenHandles: true } : {}),
    ...(options.globalSetup === undefined ? {} : { globalSetup: options.globalSetup }),
    ...(options.shard === undefined ? {} : { shard: options.shard }),
    ...(options.timings === undefined ? {} : { timings: options.timings }),
  })
}
