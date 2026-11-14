// The reporters of a `provino jest` run, as Jest sets them up (`TestScheduler._setupReporters`):
// the dialect's plan turned into the reporters `reportersFor` builds, with the Jest reporter classes
// the config names on the bus beside them, Jest's failure text in place of Provino's, and the
// summary last, as its own reporter.
import {
  createJestReporterHost,
  type JestGlobalConfig,
  type JestProjectConfig,
  type JestResults,
  jestConsoleTrace,
  jestReporterPlan,
  jestRunSummaryLine,
  jestSnapshotStatus,
  jestSnapshotSummary,
  jestUpdateCommand,
  loadJestReporters,
} from '@provino/dialect-jest/node'
import type { ConsoleEntry, Environment, OutputEnvironment } from '@provino/reporters'
import type { FileInfo, FileResult, Reporter, TextStyle } from '@provino/types'
import type { ReporterChoice } from '../types.ts'
import type { TextExtras } from './reporters.ts'
import { UsageError } from './usage-error.ts'

/**
 * What the Jest path hands `executeProject`: the reporters in Jest's order and what the text
 * reporters add.
 * @internal
 */
export interface JestReporterSetup {
  readonly reporters: readonly ReporterChoice[]
  readonly text: TextExtras
  /**
   * No text reporter will show what a reporter threw, so the run says it (jest-cli prints the
   * error that ended Jest's run).
   */
  readonly announceThrown: boolean
  /** Whether `default` is the verbose reporter: `tests.some(t => t.context.config.verbose)`. */
  readonly verbose: boolean
}

/** The built-ins that print what a reporter threw (they hear it as an `error` event). */
const TEXT_REPORTERS: ReadonlySet<string> = new Set(['default', 'verbose', 'agent', 'dot'])

/** Jest's default `summaryThreshold` (`SummaryReporter.ts`). */
const DEFAULT_SUMMARY_THRESHOLD = 20

/**
 * Sets up the run's reporters from the Jest config: loads each custom reporter module (a module
 * that fails ends the run before any file starts, as in Jest), and puts the built-ins, the hosted
 * classes and the summary in order.
 * @internal
 */
export async function setUpJestReporters(options: {
  readonly globalConfig: JestGlobalConfig
  /** The projects of the run. */
  readonly configs: readonly JestProjectConfig[]
  /** How many files each project of `configs` runs, in order; asked only when the answer matters. */
  readonly filesPerProject: () => Promise<readonly number[]>
  readonly results: JestResults<JestProjectConfig>
  readonly output: OutputEnvironment
  readonly env: Environment
  /** The coverage reporter, when the run collects coverage: Jest adds it after the others, before the summary. */
  readonly coverage?: Reporter | undefined
}): Promise<JestReporterSetup> {
  const { globalConfig, results } = options
  const environment = {
    agent: options.output.agent !== undefined,
    githubActions: options.output.githubActions,
  }
  let configs = options.configs
  let plan = jestReporterPlan(globalConfig, configs, environment)
  // Jest reads `verbose` from the projects that have a test; finding the files costs a discovery,
  // so it is done only when the projects disagree on `verbose`. `onRunStart`'s `showStatus` is the
  // run's own in-band decision (`RunInfo.inBand`), which the host reads at `run:start`.
  const mixedVerbose =
    configs.some((config) => config.verbose === true) &&
    !configs.every((config) => config.verbose === true)
  if (mixedVerbose) {
    const counts = await options.filesPerProject()
    configs = configs.filter((_, index) => (counts[index] ?? 0) > 0)
    plan = jestReporterPlan(globalConfig, configs, environment)
  }
  const verbose = globalConfig.verbose === true || configs.some((config) => config.verbose === true)
  let entries: Awaited<ReturnType<typeof loadJestReporters>>
  try {
    entries = await loadJestReporters(plan)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const hosts: Reporter[] = createJestReporterHost({
    results,
    globalConfig,
    entries,
  })
  const afterUpdate = globalConfig.updateSnapshot === 'all'
  const noteHooks = {
    // Jest renders a console entry's site with `formatStackTrace`, a code frame for `warn` and `error`.
    consoleTrace: (file: FileInfo, entry: ConsoleEntry) => {
      const config = options.configs[file.projectIndex ?? 0] ?? options.configs[0]
      return config === undefined || entry.origin === null
        ? ''
        : jestConsoleTrace(entry.origin, entry.level, config, globalConfig)
    },
    fileNotes: (file: FileResult, style: TextStyle) => {
      const snapshot = results.testResultOf(file.file.fileId)?.snapshot
      return snapshot === undefined ? undefined : jestSnapshotStatus(snapshot, afterUpdate, style)
    },
  }
  const release = hosts.at(-1)
  let hosted = 0
  const reporters: ReporterChoice[] = []
  for (const step of plan.steps) {
    if (step.kind === 'builtin' && step.name !== 'github-actions') {
      reporters.push(step.name)
      continue
    }
    const host = hosts[hosted++]
    if (host !== undefined) reporters.push(host)
  }
  // After every hosted class has seen a file, its console buffer is freed.
  if (release !== undefined) reporters.push(release)
  // `_setupReporters`: the CoverageReporter after the config's reporters, before the summary.
  if (options.coverage !== undefined) reporters.push(options.coverage)
  const announceThrown = !reporters.some(
    (reporter) => typeof reporter === 'string' && TEXT_REPORTERS.has(reporter),
  )
  if (plan.summary !== undefined) {
    const threshold = plan.summary.options.summaryThreshold
    if (threshold && typeof threshold !== 'number') {
      // SummaryReporter.ts L72-L78
      throw new UsageError('The option summaryThreshold should be a number')
    }
    reporters.push('summary')
    return {
      reporters,
      // The summary reporter is a text reporter: it prints what a reporter threw.
      announceThrown: false,
      verbose,
      text: {
        ...noteHooks,
        separateSummary: true,
        snapshotsAlways: true,
        failureText: (file) => results.failureTextOf(file.file.fileId),
        failureSummaryThreshold:
          typeof threshold === 'number' ? threshold : DEFAULT_SUMMARY_THRESHOLD,
        snapshotSummary: (_summary, style) =>
          jestSnapshotSummary(
            results.aggregated().snapshot,
            globalConfig,
            jestUpdateCommand(options.env, globalConfig.watch || globalConfig.watchAll),
            style,
          ),
        closingLine: (_summary, style) =>
          jestRunSummaryLine(
            globalConfig,
            {
              interrupted: results.aggregated().wasInterrupted,
              watch: globalConfig.watch || globalConfig.watchAll,
              contextCount: results.contexts().size,
            },
            style,
          ),
      },
    }
  }
  return {
    reporters,
    announceThrown,
    verbose,
    text: {
      ...noteHooks,
      failureText: (file) => results.failureTextOf(file.file.fileId),
    },
  }
}
