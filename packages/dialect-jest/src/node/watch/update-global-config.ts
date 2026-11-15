// jest-core `lib/updateGlobalConfig.ts` L16-L110: the global config after a watch key, as a new
// frozen object. `testPathPatterns` is the pattern list (Jest wraps it in a `TestPathPatterns`,
// whose `isSet()` is a non-empty list).
import type { JestGlobalConfig } from '../types.ts'

/**
 * What a key or a plugin may change (jest-watcher `AllowedConfigOptions`), plus the driver's own
 * `passWithNoTests`. `mode` is `--watch` or `--watchAll`.
 * @beta
 */
export interface JestWatchConfigUpdate {
  readonly bail?: boolean | number
  readonly changedSince?: string
  readonly collectCoverage?: boolean
  readonly collectCoverageFrom?: readonly string[]
  readonly coverageDirectory?: string
  readonly coverageReporters?: readonly unknown[]
  readonly findRelatedTests?: boolean
  readonly mode?: 'watch' | 'watchAll'
  readonly nonFlagArgs?: readonly string[]
  readonly notify?: boolean
  readonly notifyMode?: string
  readonly onlyFailures?: boolean
  readonly passWithNoTests?: true
  readonly reporters?: JestGlobalConfig['reporters']
  readonly testNamePattern?: string
  readonly testPathPatterns?: readonly string[]
  readonly updateSnapshot?: JestGlobalConfig['updateSnapshot']
  readonly verbose?: boolean
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * `updateGlobalConfig(globalConfig, options)`: a copy with the options applied and `onlyChanged`
 * worked out again (on unless `--watchAll`, a name pattern or a path pattern).
 * @beta
 */
export function updateJestWatchConfig(
  globalConfig: JestGlobalConfig,
  options: JestWatchConfigUpdate = {},
): JestGlobalConfig {
  const next: Mutable<JestGlobalConfig> = { ...globalConfig }
  if (options.mode === 'watch') {
    next.watch = true
    next.watchAll = false
  } else if (options.mode === 'watchAll') {
    next.watch = false
    next.watchAll = true
  }
  if (options.testNamePattern !== undefined) next.testNamePattern = options.testNamePattern || ''
  if (options.testPathPatterns !== undefined) next.testPathPatterns = [...options.testPathPatterns]
  next.onlyChanged = !next.watchAll && !next.testNamePattern && next.testPathPatterns.length === 0
  if (typeof options.bail === 'boolean') next.bail = options.bail ? 1 : 0
  else if (options.bail !== undefined) next.bail = options.bail
  if (options.changedSince !== undefined) next.changedSince = options.changedSince
  if (options.collectCoverage !== undefined) next.collectCoverage = options.collectCoverage || false
  if (options.collectCoverageFrom !== undefined)
    next.collectCoverageFrom = options.collectCoverageFrom
  if (options.coverageDirectory !== undefined) next.coverageDirectory = options.coverageDirectory
  if (options.coverageReporters !== undefined) next.coverageReporters = options.coverageReporters
  if (options.findRelatedTests !== undefined) next.findRelatedTests = options.findRelatedTests
  if (options.nonFlagArgs !== undefined) next.nonFlagArgs = options.nonFlagArgs
  if (options.notify !== undefined) next.notify = options.notify || false
  if (options.notifyMode !== undefined) next.notifyMode = options.notifyMode
  if (options.onlyFailures !== undefined) next.onlyFailures = options.onlyFailures || false
  if (options.passWithNoTests !== undefined) next.passWithNoTests = true
  if (options.reporters !== undefined) next.reporters = options.reporters
  if (options.updateSnapshot !== undefined) next.updateSnapshot = options.updateSnapshot
  if (options.verbose !== undefined) next.verbose = options.verbose || false
  return Object.freeze(next)
}
