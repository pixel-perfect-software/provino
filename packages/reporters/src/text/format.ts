// The text reporters' strings, all in one place (`default`, `verbose`, `agent`, and the failure
// blocks `dot` ends with). Jest's wording where it was recorded from Jest 30.5.2 (`cli/report-*`:
// the header line, the verbose list, the console block, the totals), Provino's own elsewhere (the
// failure message, which has Provino's frames).
import type { OpenHandle, ReportPolicy, SerializedError, SnapshotRunSummary } from '@provino/types'
import type { Style } from '../style.ts'

/** How deep a `cause` or an aggregate's `errors` are shown. */
const MAX_NESTING = 3

/** A test file's tallies. */
export interface FileCounts {
  readonly failed: number
  readonly skipped: number
  readonly passed: number
  readonly total: number
}

/** The tests' tallies, from the `test-end` events. */
export interface TestCounts extends FileCounts {
  readonly todo: number
}

/** Indents every non-empty line of `text`. */
export function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n')
}

/**
 * A file that takes longer than this is a slow one, and its header says how long it took: Jest's
 * `slowTestThreshold` default, 5 s. (The config key is not read yet.)
 */
export const SLOW_FILE_MS = 5000

/**
 * A file's path as Jest prints it (`formatTestPath`): relative to the project, and a file in the
 * project's own directory with `./` before it, so `a.test.ts` is `./a.test.ts` and
 * `src/a.test.ts` stays as it is.
 */
export function displayPath(path: string): string {
  return path.includes('/') ? path : `./${path}`
}

/** `(7.2 s)`, for a slow file, as Jest's `formatTime(runtime, 0)` writes it; `''` for any other. */
function slowDetail(durationMs: number, style: Style): string {
  if (durationMs <= SLOW_FILE_MS) return ''
  return ` (${style.red(`${Number((durationMs / 1000).toFixed(3))} s`)})`
}

/** A file's pass line, as Jest's: no timing unless the file was slow. */
export function passLine(path: string, durationMs: number, style: Style): string {
  return `${style.badge('PASS', 'green')} ${path}${slowDetail(durationMs, style)}`
}

export function failLine(path: string, durationMs: number, style: Style): string {
  return `${style.badge('FAIL', 'red')} ${path}${slowDetail(durationMs, style)}`
}

/**
 * A failure's title line: the policy's bullet then the title. Without a bullet the title is
 * indented two spaces, so it still stands out from the file line above it.
 */
export function titleLine(report: ReportPolicy, title: string, style: Style): string {
  return `${style.bold(report.failureTitleBullet ?? '  ')}${style.bold(title)}`
}

/** A test's title: its describe titles then its own, joined with the policy's separator. */
export function testTitle(report: ReportPolicy, fullName: readonly string[]): string {
  return fullName.join(report.displaySeparator)
}

/** The first line of an error: `TypeError: message`, or the message alone when `name` adds nothing. */
function header(error: SerializedError): string {
  if (error.message === '') return error.name
  if (error.name === 'Error' || error.message.startsWith(error.name)) return error.message
  return `${error.name}: ${error.message}`
}

/**
 * Whether a frame is Node's or a dependency's, as Jest's `removeInternalStackEntries` has it:
 * `node:` internals and anything under `node_modules` say nothing about the user's code.
 */
export function isLibraryFrame(frame: string): boolean {
  return frame.includes('node:') || frame.includes('node_modules')
}

/** The stack's frame lines (`at …`), without the header V8 puts before them or a library's frames. */
function frames(error: SerializedError): string[] {
  return (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !isLibraryFrame(line))
}

/** What an error's text includes. */
export interface ErrorFormat {
  /** The stack's frames under the message. Default `true`; Jest's `--noStackTrace` turns it off. */
  readonly stackTrace?: boolean
}

/**
 * An error as text: its message, the stack's frames under it (a library's left out), then its
 * cause and any errors it aggregates, each nested one level deeper. Not indented; callers indent
 * the block.
 */
export function formatError(error: SerializedError, options: ErrorFormat = {}, depth = 0): string {
  const shown = options.stackTrace === false ? [] : frames(error)
  const lines = [header(error), ...shown.map((frame) => `  ${frame}`)]
  if (depth < MAX_NESTING) {
    if (error.cause !== undefined) {
      lines.push('', 'Caused by:', indent(formatError(error.cause, options, depth + 1), 2))
    }
    for (const nested of error.errors ?? []) {
      lines.push('', 'Also:', indent(formatError(nested, options, depth + 1), 2))
    }
  }
  return lines.join('\n')
}

/** A titled block: the title line, then each error indented under it, then a blank line. */
export function failureBlock(
  report: ReportPolicy,
  title: string,
  errors: readonly SerializedError[],
  style: Style,
  options: ErrorFormat = {},
): string {
  const body = errors.map((error) => indent(formatError(error, options), 4))
  return `${titleLine(report, title, style)}\n\n${body.join('\n\n')}\n`
}

function part(count: number, label: string): string {
  return `${count} ${label}`
}

/** `1 file`, `2 files`. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The obsolete snapshots by test file, as Jest lists them above its summary, or, when the run
 * rewrote snapshots (`-u`), that they were removed; `''` when there are none.
 */
export function obsoleteBlock(snapshots: SnapshotRunSummary | undefined): string {
  if (snapshots === undefined) return ''
  const { counters, uncheckedKeysByFile, update } = snapshots
  const removed = update === 'all'
  const remove =
    update === 'none' ? 'Run without --ci and with -u to remove' : 'Run with -u to remove'
  const lines: string[] = []
  if (counters.filesRemoved > 0) {
    const files = counted(counters.filesRemoved, 'snapshot file')
    const suites = counted(counters.filesRemoved, 'test suite')
    lines.push(
      removed
        ? `${files} removed from ${suites}.`
        : `${files} obsolete from ${suites}. ${remove} ${counters.filesRemoved === 1 ? 'it' : 'them all'}.`,
    )
  }
  if (counters.unchecked > 0) {
    const noun = counted(counters.unchecked, 'snapshot')
    const suites = counted(uncheckedKeysByFile.length, 'test suite')
    lines.push(
      removed
        ? `${noun} removed from ${suites}.`
        : `${noun} obsolete from ${suites}. ${remove} ${counters.unchecked === 1 ? 'it' : 'them'}.`,
    )
    for (const { file, keys } of uncheckedKeysByFile) {
      lines.push(`  ↳ ${file}`, ...keys.map((key) => `      • ${key}`))
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * Jest's `Snapshots:` line; zero parts are left out except `total`. `undefined` when no snapshot
 * was checked, written or is obsolete. A run that rewrote snapshots (`-u`) says "removed" where
 * the others say "obsolete".
 */
export function snapshotLine(
  snapshots: SnapshotRunSummary | undefined,
  style: Style,
): string | undefined {
  if (snapshots === undefined) return undefined
  const { counters } = snapshots
  if (counters.total === 0 && counters.unchecked === 0 && counters.filesRemoved === 0) {
    return undefined
  }
  const gone = snapshots.update === 'all' ? 'removed' : 'obsolete'
  const coloured = (count: number, label: string, colour: (text: string) => string): string =>
    style.bold(colour(part(count, label)))
  const parts = [
    ...(counters.unmatched > 0 ? [coloured(counters.unmatched, 'failed', style.red)] : []),
    ...(counters.unchecked > 0 ? [coloured(counters.unchecked, gone, style.yellow)] : []),
    ...(counters.filesRemoved > 0
      ? [
          coloured(
            counters.filesRemoved,
            `${counters.filesRemoved === 1 ? 'file' : 'files'} ${gone}`,
            style.yellow,
          ),
        ]
      : []),
    ...(counters.updated > 0 ? [coloured(counters.updated, 'updated', style.green)] : []),
    ...(counters.added > 0 ? [coloured(counters.added, 'written', style.green)] : []),
    ...(counters.matched > 0 ? [coloured(counters.matched, 'passed', style.green)] : []),
    part(counters.total, 'total'),
  ]
  return `${style.bold('Snapshots:')}   ${parts.join(', ')}`
}

/**
 * Jest's summary (`getSummary` in `@jest/reporters`): a count of zero is left out, `total` apart.
 * The suites' total reads `N of M total` whenever the suites that ran (failed plus passed: a
 * skipped file is not one that ran) differ from the files queued, as Jest's does. That is a run
 * that bailed (`1 of 3 total`) and a run with a skipped file (`1 skipped, 1 passed, 1 of 2 total`,
 * and `1 skipped, 0 of 1 total` for a project whose only file is skipped). With colour on, the
 * labels are bold and each count has Jest's colour (red failed, yellow skipped, magenta todo,
 * green passed).
 */
export function summaryLines(
  files: FileCounts,
  tests: TestCounts,
  durationMs: number,
  snapshots: string | undefined,
  queued: number,
  style: Style,
): string {
  const bold = (text: string): string => style.bold(text)
  const counts = (count: number, label: string, colour: (text: string) => string): string =>
    bold(colour(`${count} ${label}`))
  const ran = files.failed + files.passed
  const suitesTotal = Math.max(queued, files.total)
  const suites = [
    ...(files.failed > 0 ? [counts(files.failed, 'failed', style.red)] : []),
    ...(files.skipped > 0 ? [counts(files.skipped, 'skipped', style.yellow)] : []),
    ...(files.passed > 0 ? [counts(files.passed, 'passed', style.green)] : []),
    ran === suitesTotal ? part(suitesTotal, 'total') : `${ran} of ${suitesTotal} total`,
  ]
  const counted = [
    ...(tests.failed > 0 ? [counts(tests.failed, 'failed', style.red)] : []),
    ...(tests.skipped > 0 ? [counts(tests.skipped, 'skipped', style.yellow)] : []),
    ...(tests.todo > 0 ? [counts(tests.todo, 'todo', style.magenta)] : []),
    ...(tests.passed > 0 ? [counts(tests.passed, 'passed', style.green)] : []),
    part(tests.total, 'total'),
  ]
  return [
    `${bold('Test Suites:')} ${suites.join(', ')}`,
    `${bold('Tests:')}       ${counted.join(', ')}`,
    ...(snapshots === undefined ? [] : [snapshots]),
    `${bold('Time:')}        ${(durationMs / 1000).toFixed(3)} s`,
  ].join('\n')
}

/**
 * Jest's report of what a run left open (`--detectOpenHandles`): how many handles, then each one's
 * kind, a code frame around the line that made it, and the stack that made it. Handles with the
 * same stack are one entry whose kinds are joined by `,` (the collector does that). Only for a
 * run that found some: the summary has no `openHandles` when it found none.
 */
export function openHandlesText(handles: readonly OpenHandle[]): string {
  const count = counted(handles.length, 'open handle')
  const blocks = handles.map((handle) => {
    const frames = handle.frames.map((frame) => `      ${frame}`).join('\n')
    const parts = [`  ●  ${handle.type}`]
    if (handle.codeFrame !== undefined) parts.push(indent(handle.codeFrame, 4))
    if (frames !== '') parts.push(frames)
    return `${parts.join('\n\n')}\n`
  })
  return `\nJest has detected the following ${count} potentially keeping Jest from exiting:\n\n${blocks.join('\n\n')}`
}
