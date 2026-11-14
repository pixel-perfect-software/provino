// The wording of Jest's summary: the closing line (`SummaryReporter._getTestSummary`), the Snapshot
// Summary (`getSnapshotSummary`, with the update command `_printSnapshotSummary` picks) and the
// per-file snapshot lines (`getSnapshotStatus`), from jest-reporters 30.5.2 (SummaryReporter.ts
// L21-L47, L125-L170, L217-L257; getSnapshotSummary.ts; getSnapshotStatus.ts;
// formatTestPath.ts and relativePath.ts). The neutral text reporters call them as hooks.
import { relative, sep } from 'node:path'
import type { SnapshotSummary, TestResult } from '@provino/dialect-jest/results'
import type { TextStyle } from '@provino/types'
import type { JestGlobalConfig } from '../types.ts'

const ARROW = ' \u203A '
const DOWN_ARROW = ' \u21B3 '
const DOT = ' \u2022 '

/** The npm events `SummaryReporter` runs without `run` before the script (`npm test`, not `npm run test`). */
const NPM_EVENTS: ReadonlySet<string> = new Set([
  'prepublish',
  'publish',
  'postpublish',
  'preinstall',
  'install',
  'postinstall',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'preversion',
  'version',
  'postversion',
  'pretest',
  'test',
  'posttest',
  'prestop',
  'stop',
  'poststop',
  'prestart',
  'start',
  'poststart',
  'prerestart',
  'restart',
  'postrestart',
])

/** `jest-util`'s `pluralize`: `1 snapshot`, `2 snapshots`. */
function pluralize(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * What the Snapshot Summary tells the user to run: ``press `u` `` in watch mode, the package
 * script that started the run (`npm test -- -u`, ``yarn test -u``) when it runs Jest, else
 * ``re-run jest with `-u` ``. `env` is the run's environment: this never reads `process.env`.
 * @public
 */
export function jestUpdateCommand(
  env: Readonly<Record<string, string | undefined>>,
  watch: boolean,
): string {
  const event = env.npm_lifecycle_event ?? ''
  const agent = env.npm_config_user_agent
  const script = env.npm_lifecycle_script
  if (watch) return 'press `u`'
  if (event !== '' && typeof script === 'string' && script.includes('jest')) {
    const prefix = NPM_EVENTS.has(event) ? '' : 'run '
    const isYarn = typeof agent === 'string' && agent.includes('yarn')
    const client = isYarn ? 'yarn' : 'npm'
    return `run \`${client} ${prefix}${event}${isYarn ? '' : ' --'} -u\``
  }
  return 're-run jest with `-u`'
}

/** `formatTestPath`: a path relative to the root, its directory dim and its name bold. */
function formatTestPath(rootDir: string, path: string, style: TextStyle): string {
  const relativePath = relative(rootDir, path)
  const slash = relativePath.lastIndexOf(sep)
  const dirname = slash === -1 ? '.' : relativePath.slice(0, slash)
  const basename = slash === -1 ? relativePath : relativePath.slice(slash + 1)
  return (style.dim(dirname + sep) + style.bold(basename)).split('\\').join('/')
}

/**
 * Jest's Snapshot Summary lines (`getSnapshotSummary`), or none when the run wrote, updated,
 * failed or found obsolete no snapshot (`_printSnapshotSummary`'s test). The caller adds the blank
 * line after them.
 * @public
 */
export function jestSnapshotSummary(
  snapshots: SnapshotSummary,
  globalConfig: Pick<JestGlobalConfig, 'rootDir'>,
  updateCommand: string,
  style: TextStyle,
): readonly string[] {
  if (
    !(
      snapshots.added ||
      snapshots.filesRemoved ||
      snapshots.unchecked ||
      snapshots.unmatched ||
      snapshots.updated
    )
  ) {
    return []
  }
  const { rootDir } = globalConfig
  const failure = (text: string): string => style.bold(style.red(text))
  const written = (text: string): string => style.bold(style.green(text))
  const obsolete = (text: string): string => style.bold(style.yellow(text))
  const note = style.dim
  const summary = [style.bold('Snapshot Summary')]
  if (snapshots.added) {
    summary.push(
      `${written(`${ARROW + pluralize('snapshot', snapshots.added)} written `)}from ${pluralize('test suite', snapshots.filesAdded)}.`,
    )
  }
  if (snapshots.unmatched) {
    summary.push(
      `${failure(`${ARROW}${pluralize('snapshot', snapshots.unmatched)} failed`)} from ${pluralize('test suite', snapshots.filesUnmatched)}. ${note(`Inspect your code changes or ${updateCommand} to update them.`)}`,
    )
  }
  if (snapshots.updated) {
    summary.push(
      `${written(`${ARROW + pluralize('snapshot', snapshots.updated)} updated `)}from ${pluralize('test suite', snapshots.filesUpdated)}.`,
    )
  }
  if (snapshots.filesRemoved) {
    if (snapshots.didUpdate) {
      summary.push(
        `${written(`${ARROW}${pluralize('snapshot file', snapshots.filesRemoved)} removed `)}from ${pluralize('test suite', snapshots.filesRemoved)}.`,
      )
    } else {
      summary.push(
        `${obsolete(`${ARROW}${pluralize('snapshot file', snapshots.filesRemoved)} obsolete `)}from ${pluralize('test suite', snapshots.filesRemoved)}. ${note(`To remove ${snapshots.filesRemoved === 1 ? 'it' : 'them all'}, ${updateCommand}.`)}`,
      )
    }
  }
  const removedList = snapshots.filesRemovedList
  if (removedList !== undefined && removedList.length > 0) {
    const [head, ...tail] = removedList
    summary.push(`  ${DOWN_ARROW} ${DOT}${formatTestPath(rootDir, head ?? '', style)}`)
    for (const key of tail) summary.push(`      ${DOT}${formatTestPath(rootDir, key, style)}`)
  }
  if (snapshots.unchecked) {
    if (snapshots.didUpdate) {
      summary.push(
        `${written(`${ARROW}${pluralize('snapshot', snapshots.unchecked)} removed `)}from ${pluralize('test suite', snapshots.uncheckedKeysByFile.length)}.`,
      )
    } else {
      summary.push(
        `${obsolete(`${ARROW}${pluralize('snapshot', snapshots.unchecked)} obsolete `)}from ${pluralize('test suite', snapshots.uncheckedKeysByFile.length)}. ${note(`To remove ${snapshots.unchecked === 1 ? 'it' : 'them all'}, ${updateCommand}.`)}`,
      )
    }
    for (const uncheckedFile of snapshots.uncheckedKeysByFile) {
      summary.push(`  ${DOWN_ARROW}${formatTestPath(rootDir, uncheckedFile.filePath, style)}`)
      for (const key of uncheckedFile.keys) summary.push(`      ${DOT}${key}`)
    }
  }
  return summary
}

/**
 * The line after the totals (`_getTestSummary`): `Ran all test suites` and what narrowed the run
 * (paths, changed files, a file pattern, a test name, the project count), or ``Test run was
 * interrupted.``. `interrupted` is the aggregate's `wasInterrupted`: Jest sets it from
 * `watcher.isInterrupted()`, which only watch mode ever raises, so outside `watch` the line is
 * never printed, and a run that a signal cut has no closing line at all (Jest's process ends).
 * Nothing under `--silent`.
 * @public
 */
export function jestRunSummaryLine(
  globalConfig: Pick<
    JestGlobalConfig,
    | 'findRelatedTests'
    | 'nonFlagArgs'
    | 'onlyChanged'
    | 'runTestsByPath'
    | 'silent'
    | 'testNamePattern'
    | 'testPathPatterns'
  >,
  run: {
    readonly interrupted: boolean
    readonly contextCount: number
    /** `--watch` or `--watchAll`. */
    readonly watch?: boolean
  },
  style: TextStyle,
): string | undefined {
  if (globalConfig.silent) return undefined
  if (run.interrupted) {
    return run.watch === true ? style.bold(style.red('Test run was interrupted.')) : undefined
  }
  const patterns = globalConfig.testPathPatterns
  let testInfo = ''
  if (globalConfig.runTestsByPath) {
    testInfo = style.dim(' within paths')
  } else if (globalConfig.onlyChanged) {
    testInfo = style.dim(' related to changed files')
  } else if (patterns.length > 0) {
    const prefix = globalConfig.findRelatedTests ? ' related to files matching ' : ' matching '
    testInfo = style.dim(prefix) + patterns.join('|')
  }
  let nameInfo = ''
  if (globalConfig.runTestsByPath) {
    nameInfo = ` ${globalConfig.nonFlagArgs.map((p) => `"${p}"`).join(', ')}`
  } else if (globalConfig.testNamePattern) {
    nameInfo = `${style.dim(' with tests matching ')}"${globalConfig.testNamePattern}"`
  }
  const contextInfo =
    run.contextCount > 1 ? style.dim(' in ') + run.contextCount + style.dim(' projects') : ''
  return style.dim('Ran all test suites') + testInfo + nameInfo + contextInfo + style.dim('.')
}

/**
 * The lines under a file's header about its snapshots (`getSnapshotStatus`): written, updated,
 * failed, obsolete (removed after `-u`) with each obsolete key, and a deleted `.snap`.
 * @public
 */
export function jestSnapshotStatus(
  snapshot: TestResult['snapshot'],
  afterUpdate: boolean,
  style: TextStyle,
): readonly string[] {
  const statuses: string[] = []
  const green = (text: string): string => style.bold(style.green(text))
  if (snapshot.added) {
    statuses.push(green(`${ARROW + pluralize('snapshot', snapshot.added)} written.`))
  }
  if (snapshot.updated) {
    statuses.push(green(`${ARROW + pluralize('snapshot', snapshot.updated)} updated.`))
  }
  if (snapshot.unmatched) {
    statuses.push(
      style.bold(style.red(`${ARROW + pluralize('snapshot', snapshot.unmatched)} failed.`)),
    )
  }
  if (snapshot.unchecked) {
    if (afterUpdate) {
      statuses.push(green(`${ARROW + pluralize('snapshot', snapshot.unchecked)} removed.`))
    } else {
      statuses.push(
        `${style.bold(style.yellow(`${ARROW + pluralize('snapshot', snapshot.unchecked)} obsolete`))}.`,
      )
    }
    for (const key of snapshot.uncheckedKeys) statuses.push(`  ${DOT}${key}`)
  }
  if (snapshot.fileDeleted) statuses.push(green(`${ARROW}snapshot file removed.`))
  return statuses
}
