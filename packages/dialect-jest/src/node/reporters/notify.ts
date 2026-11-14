// `--notify` and `--notifyMode`: Jest's `NotifyReporter` (@jest/reporters 30.5.2 `NotifyReporter.ts`,
// whole file) as a neutral reporter. It runs after the run's last file, reads the aggregate, and
// hands `node-notifier` a title and a message. `node-notifier` is Jest's optional peer
// dependency: it is never a dependency of Provino, so it is found where Jest's own `require` would
// find it, in the project (its `rootDir`) and in the install of `@jest/reporters`.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import type { AggregatedResult } from '@provino/dialect-jest/results'
import type { Reporter } from '@provino/types'

const isDarwin = process.platform === 'darwin'

/** `jest-util`'s `pluralize`: `1 test`, `2 tests`. */
function pluralize(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * The part of `node-notifier` the reporter uses.
 * @public
 */
export interface JestNotifier {
  notify(options: Readonly<Record<string, unknown>>): void
}

/**
 * Raised when `node-notifier` can't be found: Jest's text (`NotifyReporter.loadNotifier`), thrown
 * where Jest constructs the reporter, so before any file runs. The run ends with its stack.
 * @public
 */
export class JestNotifierMissingError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'notify reporter requires optional peer dependency "node-notifier" but it was not found',
      options,
    )
  }
}

/** A module's resolved path from `from`, or `undefined` for any failure to resolve it. */
function resolveFrom(from: string, specifier: string): string | undefined {
  try {
    return createRequire(join(from, 'package.json')).resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * The directory of the `@jest/reporters` install a project's Jest uses: next to the project's own
 * `node_modules`, else through `@jest/core` (where `jest`'s own packages live under pnpm).
 */
function jestReportersDir(rootDir: string): string | undefined {
  const direct = resolveFrom(rootDir, '@jest/reporters/package.json')
  if (direct !== undefined) return dirname(direct)
  for (const start of ['@jest/core', 'jest-cli', 'jest']) {
    const entry = resolveFrom(rootDir, `${start}/package.json`)
    if (entry === undefined) continue
    const found = resolveFrom(dirname(entry), '@jest/reporters/package.json')
    if (found !== undefined) return dirname(found)
  }
  return undefined
}

/**
 * `node-notifier` and what the notification names beside it.
 * @public
 */
export interface JestNotifierLoad {
  readonly notifier: JestNotifier
  /** The `jest_logo.png` of the `@jest/reporters` install, Jest's icon; absent when none is found. */
  readonly icon?: string
}

/**
 * Loads `node-notifier` from the project, then from where Jest's `@jest/reporters` is installed
 * (Jest's `require` runs from there), and finds the icon in that install: one search for both.
 * `JestNotifierMissingError` when neither has the module; any other error it throws on load is the
 * caller's.
 * @public
 */
export function loadJestNotifier(rootDir: string): JestNotifierLoad {
  const reporters = jestReportersDir(rootDir)
  let path = resolveFrom(rootDir, 'node-notifier')
  if (path === undefined && reporters !== undefined) path = resolveFrom(reporters, 'node-notifier')
  if (path === undefined) throw new JestNotifierMissingError()
  const loaded: unknown = createRequire(path)(path)
  const notifier =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded
  if (
    typeof notifier !== 'object' ||
    notifier === null ||
    !('notify' in notifier) ||
    typeof notifier.notify !== 'function'
  ) {
    throw new JestNotifierMissingError()
  }
  const logo = reporters === undefined ? undefined : join(reporters, 'assets', 'jest_logo.png')
  return {
    notifier: notifier as JestNotifier,
    ...(logo !== undefined && existsSync(logo) ? { icon: logo } : {}),
  }
}

/**
 * The name the title starts with: the root `package.json`'s `name` (Jest reads it from the haste
 * map, `hasteFS.getModuleName`), the root directory when there is no `package.json`, nothing when
 * there is one with no name.
 */
function packageNameOf(rootDir: string): string {
  const file = join(rootDir, 'package.json')
  if (!existsSync(file)) return rootDir
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const { name } = parsed
      if (typeof name === 'string' && name !== '') return name
    }
  } catch {
    // An unreadable package.json has no name: the same as one without.
  }
  return ''
}

/**
 * What `createNotifyReporter` reads of the global config.
 * @public
 */
export interface JestNotifyConfig {
  readonly rootDir: string
  readonly notifyMode: string
}

/**
 * Jest's `NotifyReporter` as a reporter of the run. `previousSuccess` and `firstRun` are the
 * context `runJest` gives a run that is not watching (`true` and `true`), which no `notifyMode`
 * tells apart from a first run; watch mode is not built.
 * @public
 */
export function createNotifyReporter(options: {
  readonly globalConfig: JestNotifyConfig
  /** What `loadJestNotifier` found. */
  readonly loaded: JestNotifierLoad
  /** The run's aggregate, complete once `run:end` has been heard. */
  readonly aggregated: () => AggregatedResult
}): Reporter {
  const { globalConfig } = options
  const { notifier, icon } = options.loaded
  const context = { previousSuccess: true, firstRun: true }
  return {
    name: 'jest-notify',
    'run:end'() {
      const result = options.aggregated()
      const success = result.numFailedTests === 0 && result.numRuntimeErrorTestSuites === 0
      const rawName = packageNameOf(globalConfig.rootDir)
      const packageName = rawName === '' ? '' : `${rawName} - `
      const { notifyMode } = globalConfig
      const statusChanged = context.previousSuccess !== success || context.firstRun
      const testsHaveRun = result.numTotalTests !== 0
      const common = { hint: 'int:transient:1', ...(icon === undefined ? {} : { icon }) }
      if (
        testsHaveRun &&
        success &&
        (notifyMode === 'always' ||
          notifyMode === 'success' ||
          notifyMode === 'success-change' ||
          (notifyMode === 'change' && statusChanged) ||
          (notifyMode === 'failure-change' && statusChanged))
      ) {
        notifier.notify({
          ...common,
          message: `${isDarwin ? '✅ ' : ''}${pluralize('test', result.numPassedTests)} passed`,
          timeout: false,
          title: format('%s%d%% Passed', packageName, 100),
        })
      } else if (
        testsHaveRun &&
        !success &&
        (notifyMode === 'always' ||
          notifyMode === 'failure' ||
          notifyMode === 'failure-change' ||
          (notifyMode === 'change' && statusChanged) ||
          (notifyMode === 'success-change' && statusChanged))
      ) {
        const failed = result.numFailedTests / result.numTotalTests
        notifier.notify({
          ...common,
          message: format(
            `${isDarwin ? '⛔️ ' : ''}%d of %d tests failed`,
            result.numFailedTests,
            result.numTotalTests,
          ),
          timeout: false,
          title: format(
            '%s%d%% Failed',
            packageName,
            Math.ceil(Number.isNaN(failed) ? 0 : failed * 100),
          ),
        })
      }
      context.previousSuccess = success
      context.firstRun = false
    },
  }
}
