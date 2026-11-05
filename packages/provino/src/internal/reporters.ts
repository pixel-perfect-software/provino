import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import { defaultReporter, normalizedJsonReporter, type TextSink } from '@provino/reporters'
import type { Reporter } from '@provino/types'
import { UsageError } from './usage-error.ts'

/**
 * The reporters `run()` and the command line can name.
 * @internal
 */
export const BUILT_IN_REPORTERS: readonly string[] = ['default', 'normalized-json']

/**
 * What the built-in reporters are made from.
 * @internal
 */
export interface ReporterContext {
  readonly project: ResolvedProject
  /** `outputFile` is relative to this. */
  readonly cwd: string
  readonly stdout: TextSink
  readonly stderr: TextSink
  /** This package's version: `NormalizedRun.runnerVersion`. */
  readonly runnerVersion: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReporter(value: unknown): value is Reporter {
  return isRecord(value) && typeof value.name === 'string'
}

function describeChoice(choice: unknown): string {
  return typeof choice === 'string' ? JSON.stringify(choice) : typeof choice
}

/** An optional string option; anything else is a usage error naming the option. */
function optionalString(
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = options[key]
  if (value === undefined || typeof value === 'string') return value
  throw new UsageError(`the "${key}" option of the normalized-json reporter must be a string`)
}

/** A reporter, and what `reportersFor` needs to know about it to order and check the set. */
interface Built {
  readonly reporter: Reporter
  /** The built-in `normalized-json` reporter. */
  readonly json: boolean
  /** It writes to stdout rather than to a file. */
  readonly toStdout: boolean
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normalizedJson(context: ReporterContext, options: unknown): Built {
  if (options !== undefined && !isRecord(options)) {
    throw new UsageError('the options of the normalized-json reporter must be an object')
  }
  const outputFile = optionalString(options ?? {}, 'outputFile')
  const suite = optionalString(options ?? {}, 'suite')
  const { project } = context
  if (outputFile === '') {
    throw new UsageError('the "outputFile" option of the normalized-json reporter is empty')
  }
  const path = outputFile === undefined ? undefined : resolve(context.cwd, outputFile)
  // Checked now, so a path that can never be written doesn't cost a whole run.
  if (path !== undefined && isDirectory(path)) {
    throw new UsageError(
      `the outputFile "${outputFile}" of the normalized-json reporter is a directory`,
    )
  }
  const reporter = normalizedJsonReporter({
    ...(path === undefined ? { stream: context.stdout } : { outputFile: path }),
    suite: suite ?? basename(project.rootDir),
    runner: `provino:${project.dialect?.name ?? 'neutral'}`,
    runnerVersion: context.runnerVersion,
    // The run's own answer, so `env.ci` in the file is what the run used.
    ci: project.config.ci,
    // The policy that decides the exit code, so the file's `success` agrees with it.
    unhandledErrors: project.policy.orchestrator.unhandledErrors,
  })
  return { reporter, json: true, toStdout: path === undefined }
}

function reporterFor(choice: unknown, context: ReporterContext): Built {
  if (choice === 'default') {
    return {
      reporter: defaultReporter({ stream: context.stderr, report: context.project.policy.report }),
      json: false,
      toStdout: false,
    }
  }
  if (choice === 'normalized-json') return normalizedJson(context, undefined)
  if (Array.isArray(choice)) {
    const [name, options, ...rest]: unknown[] = choice
    if (name === 'normalized-json' && rest.length === 0) return normalizedJson(context, options)
  } else if (isReporter(choice)) {
    return { reporter: choice, json: false, toStdout: false }
  }
  throw new UsageError(
    `unknown reporter ${describeChoice(choice)}; use ${BUILT_IN_REPORTERS.map((name) => JSON.stringify(name)).join(', ')}, ["normalized-json", { outputFile }] or a reporter object`,
  )
}

/**
 * The reporters for a run: `choices`, else the policy's `report.defaultReporters` (each a
 * built-in name). A choice that is none of the built-ins, an options tuple or a reporter object
 * is a `UsageError`.
 * @internal
 */
export function reportersFor(
  choices: readonly unknown[] | undefined,
  context: ReporterContext,
): Reporter[] {
  if (choices !== undefined && !Array.isArray(choices)) {
    throw new UsageError('the reporters option must be an array')
  }
  const built = (choices ?? context.project.policy.report.defaultReporters).map((choice) =>
    reporterFor(choice, context),
  )
  if (built.filter((entry) => entry.toStdout).length > 1) {
    throw new UsageError(
      'two normalized-json reporters would both write to stdout; give each an outputFile',
    )
  }
  // Last, so it sees every other reporter's failure (the bus tells the reporters after a failing
  // one about it before they get the same event) before it writes its document.
  return [...built.filter((entry) => !entry.json), ...built.filter((entry) => entry.json)].map(
    (entry) => entry.reporter,
  )
}
