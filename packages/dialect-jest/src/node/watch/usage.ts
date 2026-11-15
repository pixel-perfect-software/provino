// jest-core `lib/activeFiltersMessage.ts` L12-L33 and `watch.ts` L536-L590: the Active Filters
// line, the Watch Usage block and the one-line prompt that replaces it after the first run.
import type { TextStyle } from '@provino/types'
import type { JestGlobalConfig } from '../types.ts'
import { getSortedUsageRows, type JestWatchPlugin } from './plugin.ts'

/**
 * `activeFilters(globalConfig)`: `\nActive Filters: filename <patterns>, test name /<pattern>/`,
 * or `''` with no filter. The path patterns print as `TestPathPatterns.toPretty()` does, joined by `|`.
 * @beta
 */
export function jestActiveFilters(globalConfig: JestGlobalConfig, style: TextStyle): string {
  const { testNamePattern } = globalConfig
  const paths = globalConfig.testPathPatterns
  if (!testNamePattern && paths.length === 0) return ''
  const filters = [
    paths.length > 0 ? style.dim('filename ') + style.yellow(paths.join('|')) : null,
    testNamePattern ? style.dim('test name ') + style.yellow(`/${testNamePattern}/`) : null,
  ]
    .filter((filter) => filter !== null)
    .join(', ')
  return `\n${style.bold('Active Filters: ')}${filters}`
}

/**
 * `usage(globalConfig, watchPlugins)` (`watch.ts` L536-L584). `noSCM` is never set in Jest 30.5.2's
 * own runs (`updateGlobalConfig` is never passed it), so the `o` row depends on the mode and the
 * filters only.
 * @beta
 */
export function jestWatchUsage(
  globalConfig: JestGlobalConfig,
  plugins: readonly JestWatchPlugin[],
  style: TextStyle,
  delimiter = '\n',
): string {
  const filtered = globalConfig.testPathPatterns.length > 0 || Boolean(globalConfig.testNamePattern)
  const press = (key: string, what: string): string =>
    `${style.dim(' › Press ')}${key}${style.dim(what)}`
  const messages = [
    jestActiveFilters(globalConfig, style),
    filtered ? press('c', ' to clear filters.') : null,
    `\n${style.bold('Watch Usage')}`,
    globalConfig.watch ? press('a', ' to run all tests.') : null,
    globalConfig.onlyFailures
      ? press('f', ' to quit "only failed tests" mode.')
      : press('f', ' to run only failed tests.'),
    (globalConfig.watchAll || filtered) && !globalConfig.noSCM
      ? press('o', ' to only run tests related to changed files.')
      : null,
    ...getSortedUsageRows(plugins, globalConfig).map(
      (row) => `${style.dim(' › Press')} ${row.key} ${style.dim(`to ${row.prompt}.`)}`,
    ),
    press('Enter', ' to trigger a test run.'),
  ]
  return `${messages.filter((message) => !!message).join(delimiter)}\n`
}

/**
 * `showToggleUsagePrompt()` (`watch.ts` L586-L590).
 * @beta
 */
export function jestToggleUsagePrompt(style: TextStyle): string {
  return `\n${style.bold('Watch Usage: ')}${style.dim('Press ')}w${style.dim(' to show more.')}`
}
