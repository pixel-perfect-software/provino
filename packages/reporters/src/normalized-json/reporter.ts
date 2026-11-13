import { resolve } from 'node:path'
import type { Reporter, RunEnvironment } from '@provino/types'
import { createCollector } from '../internal/collect.ts'
import { writeAtomically } from '../internal/write-file.ts'
import type { TextSink } from '../sink.ts'
import { buildNormalizedRun, type UnhandledErrors } from './build.ts'
import { readRunEnvironment } from './environment.ts'
import { normalizeSnapshots } from './snapshots.ts'

/**
 * Options for `normalizedJsonReporter`.
 * @public
 */
export interface NormalizedJsonReporterOptions {
  /** Where the JSON goes. It wins over `stream`; its directory is created. */
  readonly outputFile?: string
  /** Where it goes without an `outputFile`. Default: `process.stdout`. */
  readonly stream?: TextSink
  /** The corpus id: `NormalizedRun.suite`. */
  readonly suite: string
  /** `NormalizedRun.runner`, e.g. `provino:jest`. */
  readonly runner: string
  /** `NormalizedRun.runnerVersion`. */
  readonly runnerVersion: string
  /** The machine. Default: read from `node:os` and `process`, with `runners: { provino: runnerVersion }`. */
  readonly env?: RunEnvironment
  /**
   * Whether the run is a CI run: `NormalizedRun.env.ci`, over `env.ci` when both are given. Give
   * the run's own answer, so the file agrees with what the run did. Default: read from the `CI`
   * environment variable (set to anything but empty, `0` or `false`, ignoring case and spaces).
   */
  readonly ci?: boolean
  /**
   * What the run does about unhandled errors: the orchestrator's `unhandledErrors` policy. Under
   * `fail-run` (default) they fail the file they are charged to and the run; under `ignore` they
   * are still recorded (`fileError`, `runErrors`) but `success` and the file's status ignore them,
   * so `success` agrees with the exit code.
   */
  readonly unhandledErrors?: UnhandledErrors
  /** The wall clock, in epoch milliseconds, for `startedAt`. Default `Date.now`. */
  readonly now?: () => number
}

/** The machine the run is on: `options.env` or the one read from this process, with `options.ci` over its `ci`. */
function runEnvironment(options: NormalizedJsonReporterOptions): RunEnvironment {
  const machine = options.env ?? readRunEnvironment({ provino: options.runnerVersion })
  return options.ci === undefined ? machine : { ...machine, ci: options.ci }
}

/**
 * The `normalized-json` reporter (U4): collects the run's events and, at `run:end`, writes one
 * `NormalizedRun` (Track 12's result model) to a file or a stream. It is the same model the
 * harness's converters write for Jest and Vitest, so a Provino run diffs against theirs.
 *
 * - A test's identity is its file, its `fullName` and its `dupIndex`; its status comes from its
 *   `test-end`. A test collected but never ended is `notRun`.
 * - A file whose worker died is `crashed`, with `fileError` naming the cause; the tests that
 *   ended keep their status and the rest are `notRun`.
 * - `runErrors` are the unhandled errors tied to no file, and every `error` event.
 * - A write that fails throws from the `run:end` handler, so the bus records it and the run fails.
 * @public
 */
export function normalizedJsonReporter(options: NormalizedJsonReporterOptions): Reporter {
  const now = options.now ?? Date.now
  const { record, handlers } = createCollector()
  let startedAt: string | undefined

  return {
    name: 'normalized-json',

    ...handlers,

    'run:start'(info, files) {
      handlers['run:start'](info, files)
      startedAt = new Date(now()).toISOString()
    },

    async 'run:end'(summary) {
      const run = buildNormalizedRun({
        runner: options.runner,
        runnerVersion: options.runnerVersion,
        suite: options.suite,
        startedAt: startedAt ?? new Date(now()).toISOString(),
        env: runEnvironment(options),
        files: record.files,
        runErrors: record.runErrors,
        reason: summary.reason,
        unhandledErrors: options.unhandledErrors ?? 'fail-run',
        ...(summary.snapshots === undefined
          ? {}
          : { snapshots: await normalizeSnapshots(summary.snapshots, record.root) }),
      })
      const text = `${JSON.stringify(run, null, 2)}\n`
      if (options.outputFile !== undefined) {
        const path = resolve(options.outputFile)
        await writeAtomically(path, text)
      } else {
        await (options.stream ?? process.stdout).write(text)
      }
    },
  }
}

/**
 * The `json` reporter: the `NormalizedRun` document, which is Provino's one documented JSON shape
 * (Track 12's result model; the one `provino-harness` diffs against Jest's and Vitest's). It is
 * `normalizedJsonReporter` under the name `json`; both names stay. Jest's own `--json` shape is
 * not it (that is T11.8).
 * @public
 */
export function jsonReporter(options: NormalizedJsonReporterOptions): Reporter {
  return { ...normalizedJsonReporter(options), name: 'json' }
}
