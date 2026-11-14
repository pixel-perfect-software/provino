// Jest 30.5.2's coverage config as the neutral coverage reads it (B23b, T8.10): which files a
// worker counts (`shouldInstrument`'s inputs, `@jest/transform` shouldInstrument.ts), and what the
// coordinator reports (`CoverageReporter.onRunComplete`, `getWatermarks`, `getMaxCols`), plus the
// lines Jest's CoverageReporter prints around the reports.
import type { JsonValue, RunCoverageOptions, SerializedCoverageConfig } from '@provino/types'
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

/**
 * Which files of `project` count toward coverage, as `shouldInstrument` decides with Jest's
 * options: `forceCoverageMatch`, the test files (`testMatch`, `testRegex`, unless
 * `testPathIgnorePatterns` matches), `collectCoverageFrom` relative to the run's `rootDir`,
 * `coveragePathIgnorePatterns`, and the setup and global hook files.
 * @public
 */
export function jestCoverageFilter(
  project: JestProjectConfig,
  globalConfig: JestGlobalConfig,
): SerializedCoverageConfig {
  return {
    provider: globalConfig.coverageProvider === 'v8' ? 'v8' : 'istanbul',
    globalRoot: globalConfig.rootDir,
    projectRoot: project.rootDir,
    include: [...globalConfig.collectCoverageFrom],
    includeRoot: true,
    force: [...project.forceCoverageMatch],
    testFiles: [...project.testMatch],
    testRegex: [...project.testRegex],
    testIgnorePatterns: [...project.testPathIgnorePatterns],
    excludePatterns: [...project.coveragePathIgnorePatterns],
    excludePaths: [
      ...(project.globalSetup === undefined ? [] : [project.globalSetup]),
      ...(project.globalTeardown === undefined ? [] : [project.globalTeardown]),
      ...project.setupFiles,
      ...project.setupFilesAfterEnv,
    ],
  }
}

/**
 * What `jestCoverageOptions` reads besides the config.
 * @public
 */
export interface JestCoverageEnvironment {
  /** The variables `getMaxCols` reads (`COLUMNS`, `CI`, `GITHUB_ACTIONS`, `JEST_WORKER_ID`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** `process.stdout.columns`: the terminal's width, `undefined` when stdout is no terminal. */
  readonly stdoutColumns: number | undefined
}

/**
 * `getMaxCols` (CoverageReporter.ts L38-L57): the terminal's width, else `COLUMNS`, else 80 in CI
 * (`CI` or `GITHUB_ACTIONS` exactly `'true'`, outside a Jest worker), else no limit.
 */
function maxCols({ env, stdoutColumns }: JestCoverageEnvironment): number {
  if (stdoutColumns) return stdoutColumns
  const envColumns = Number.parseInt(env.COLUMNS || '', 10)
  if (envColumns) return envColumns
  const isCI = env.CI === 'true' || env.GITHUB_ACTIONS === 'true'
  if (isCI && !env.JEST_WORKER_ID) return 80
  return Number.POSITIVE_INFINITY
}

/** `istanbul-lib-report`'s `getDefaultWatermarks()` (watermarks.js): `[50, 80]` for every metric. */
const DEFAULT_WATERMARK: readonly [number, number] = [50, 80]

/** Whether a value is JSON (a reporter's options come from a config file). */
function isJson(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJson)
  return typeof value === 'object' && Object.values(value as object).every(isJson)
}

/** A config's reporter entry: a name, or `[name, options]` (its JSON options; anything else is left out). */
function reporterEntry(
  entry: unknown,
): readonly [string, Readonly<Record<string, JsonValue>>] | undefined {
  if (typeof entry === 'string') return [entry, {}]
  if (Array.isArray(entry) && typeof entry[0] === 'string') {
    const options: unknown = entry[1]
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      return [entry[0], {}]
    }
    return [
      entry[0],
      Object.fromEntries(Object.entries(options).filter(([, value]) => isJson(value))),
    ]
  }
  return undefined
}

/**
 * What the coordinator reports with, from Jest's global config: the provider (`babel` is
 * Istanbul), `coverageReporters` (`[]` becomes `['text-summary']` unless `useStderr`), each with
 * `maxCols` under its own options, the directory, `getWatermarks` (the `global` thresholds raise
 * the high marks) and the threshold groups in config order.
 * @public
 */
export function jestCoverageOptions(
  globalConfig: JestGlobalConfig,
  environment: JestCoverageEnvironment,
): RunCoverageOptions {
  const configured = globalConfig.coverageReporters.flatMap((entry) => {
    const parsed = reporterEntry(entry)
    return parsed === undefined ? [] : [parsed]
  })
  const named: readonly (readonly [string, Readonly<Record<string, JsonValue>>])[] =
    !globalConfig.useStderr && configured.length === 0 ? [['text-summary', {}]] : configured
  const cols = maxCols(environment)
  const thresholds = globalConfig.coverageThreshold ?? {}
  const global = thresholds.global
  const high = (metric: 'statements' | 'branches' | 'functions' | 'lines'): number => {
    const value: unknown =
      typeof global === 'object' && global !== null
        ? (global as Readonly<Record<string, unknown>>)[metric]
        : undefined
    return typeof value === 'number' ? value : (DEFAULT_WATERMARK[1] as number)
  }
  const watermark = (
    metric: 'statements' | 'branches' | 'functions' | 'lines',
  ): readonly [number, number] => [DEFAULT_WATERMARK[0], high(metric)]
  return {
    provider: globalConfig.coverageProvider === 'v8' ? 'v8' : 'istanbul',
    reporters: named.map(([name, options]) => [name, { maxCols: cols, ...options }]),
    directory: globalConfig.coverageDirectory,
    watermarks: {
      statements: watermark('statements'),
      branches: watermark('branches'),
      functions: watermark('functions'),
      lines: watermark('lines'),
    },
    thresholds: Object.entries(thresholds).flatMap(([name, values]) => {
      if (typeof values !== 'object' || values === null) return []
      const group: Record<string, number> = {}
      for (const metric of ['statements', 'branches', 'functions', 'lines'] as const) {
        const value: unknown = (values as Readonly<Record<string, unknown>>)[metric]
        if (typeof value === 'number') group[metric] = value
      }
      return [{ name, ...group }]
    }),
  }
}

/**
 * The texts Jest's CoverageReporter prints around the reports, uncoloured (the caller colours
 * them: `RUNNING_TEST_COLOR` is bold dim, the failures `chalk.red`).
 * @public
 */
export const jestCoverageTexts: {
  /** While the files no test loaded are covered, on a terminal (L159). */
  readonly untestedNotice: string
  /** A file no test loaded whose coverage failed (L207-L213). */
  untestedFailure(path: string, message: string, stack: string | undefined): string
  /** The reports failed (L118-L124): the template's own indentation is kept. */
  reportFailure(text: string, stack: string | undefined): string
} = {
  untestedNotice: 'Running coverage on untested files...',
  untestedFailure: (path, message, stack) =>
    [`Failed to collect coverage from ${path}`, `ERROR: ${message}`, `STACK: ${stack}`].join('\n'),
  reportFailure: (text, stack) =>
    `\n        Failed to write coverage reports:\n        ERROR: ${text}\n        STACK: ${stack}\n      `,
}
