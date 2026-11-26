// Coverage under `provino run` (B28, D212): the coverage reporter and the hooks the orchestrator
// reads, built from the resolved `coverage` key. It loads `@provino/coverage/node` through
// `coverage-reporter.ts`, so `run()` imports this file only for a run that collects (T1.10).
import type { RunCoverageHooks } from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { JsonValue, RunCoverageOptions } from '@provino/types'
import {
  type CoverageReporter,
  type CoverageTexts,
  createCoverageReporter,
} from './coverage-reporter.ts'
import { outputFor, styleOf } from './reporters.ts'
import type { ResolvedRun } from './run-setup.ts'

/** The lines the coverage reporter prints around the reports: Provino's own words. */
export const nativeCoverageTexts: CoverageTexts & { readonly untestedNotice: string } = {
  untestedNotice: 'Running coverage on untested files...',
  untestedFailure: (path, message, stack) =>
    `Failed to collect coverage from ${path}\nERROR: ${message}${stack === undefined ? '' : `\nSTACK: ${stack}`}`,
  reportFailure: (text, stack) =>
    `Failed to write coverage reports:\nERROR: ${text}${stack === undefined ? '' : `\nSTACK: ${stack}`}`,
}

/** Istanbul's default watermarks (`getDefaultWatermarks()`): `[50, 80]` for every metric. */
const WATERMARKS: RunCoverageOptions['watermarks'] = {
  statements: [50, 80],
  branches: [50, 80],
  functions: [50, 80],
  lines: [50, 80],
}

/**
 * What a run that collects coverage adds to `executeProject`: the reporter and the orchestrator's
 * hooks (thresholds, the notice on a terminal while untested files are covered).
 * @internal
 */
export interface NativeCoverage {
  readonly reporter: CoverageReporter
  readonly hooks: RunCoverageHooks
}

/**
 * The reporter and hooks of the run `resolved` describes. The thresholds are checked in the
 * coordinator and resolve against the run's root. `reportEmptyRun` follows `passWithNoTests`: with
 * it a run that found no file still writes its (empty) reports.
 * @internal
 */
export function nativeCoverageFor(
  resolved: ResolvedRun,
  io: {
    readonly stdout: TextSink
    readonly stderr: NodeJS.WritableStream
    readonly ci: boolean
    readonly passWithNoTests: boolean | undefined
  },
): NativeCoverage {
  const { coverage, env, project } = resolved
  const { stdout, stderr } = io
  const columns: unknown = Reflect.get(stdout, 'columns')
  const output = outputFor({ env, stderr: stdout, ci: io.ci })
  const style = styleOf(output)
  const options: RunCoverageOptions = {
    provider: coverage.provider,
    reporters: coverage.reporters.map(
      ([name, given]): readonly [string, Record<string, JsonValue>] => [
        name,
        { ...(typeof columns === 'number' && columns > 0 ? { maxCols: columns } : {}), ...given },
      ],
    ),
    directory: coverage.directory,
    watermarks: WATERMARKS,
    thresholds: coverage.thresholds,
  }
  const reporter = createCoverageReporter({
    options,
    stdout,
    stderr,
    consoleColour: output.colour,
    style,
    texts: nativeCoverageTexts,
  })
  const hooks: RunCoverageHooks = {
    thresholds: options.thresholds,
    thresholdsCwd: resolved.root ?? project.rootDir,
    reportEmptyRun: io.passWithNoTests ?? project.policy.orchestrator.passWithNoTests,
    ...(output.live
      ? {
          onUntested: {
            start: () => stderr.write(style.bold(style.dim(nativeCoverageTexts.untestedNotice))),
            end: () => {
              if (Reflect.get(stderr, 'isTTY') === true) stderr.write('\x1b[999D\x1b[K')
            },
          },
        }
      : {}),
  }
  return { reporter, hooks }
}
