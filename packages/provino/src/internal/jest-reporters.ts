// The reporters of a `provino jest` run, as Jest sets them up (`TestScheduler._setupReporters`):
// the dialect's plan turned into the reporters `reportersFor` builds, with the Jest reporter classes
// the config names on the bus beside them, Jest's failure text in place of Provino's, and the
// summary last, as its own reporter.
import {
  createJestReporterHost,
  type JestGlobalConfig,
  type JestProjectConfig,
  type JestResults,
  jestReporterPlan,
  loadJestReporters,
} from '@provino/dialect-jest/node'
import type { Environment, OutputEnvironment } from '@provino/reporters'
import type { Reporter } from '@provino/types'
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
}

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
  readonly configs: readonly JestProjectConfig[]
  readonly results: JestResults<JestProjectConfig>
  readonly output: OutputEnvironment
  readonly env: Environment
}): Promise<JestReporterSetup> {
  const { globalConfig, results } = options
  const plan = jestReporterPlan(globalConfig, options.configs, {
    agent: options.output.agent !== undefined,
    githubActions: options.output.githubActions,
  })
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
    showStatus: globalConfig.maxWorkers > 1,
  })
  const release = hosts.at(-1)
  let hosted = 0
  const reporters: ReporterChoice[] = []
  for (const step of plan.steps) {
    if (step.kind === 'builtin') {
      reporters.push(step.name)
      continue
    }
    const host = hosts[hosted++]
    if (host !== undefined) reporters.push(host)
  }
  // After every hosted class has seen a file, its console buffer is freed.
  if (release !== undefined) reporters.push(release)
  if (plan.summary !== undefined) {
    const threshold = plan.summary.options.summaryThreshold
    if (threshold !== undefined && threshold !== 0 && typeof threshold !== 'number') {
      // SummaryReporter.ts L72-L78
      throw new UsageError('The option summaryThreshold should be a number')
    }
    reporters.push('summary')
    return {
      reporters,
      text: {
        separateSummary: true,
        snapshotsAlways: true,
        failureText: (file) => results.testResultOf(file.file.fileId)?.failureMessage ?? undefined,
        failureSummaryThreshold:
          typeof threshold === 'number' ? threshold : DEFAULT_SUMMARY_THRESHOLD,
      },
    }
  }
  return {
    reporters,
    text: {
      failureText: (file) => results.testResultOf(file.file.fileId)?.failureMessage ?? undefined,
    },
  }
}
