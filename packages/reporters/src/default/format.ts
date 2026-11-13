// The default reporter's text, all in one place. It is Jest-like, not a golden: T9.7 records the
// real format and decides what to match.
import type { OpenHandle, ReportPolicy, SerializedError, SnapshotRunSummary } from '@provino/types'

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

/** A file's pass line: its path and how long it took. */
export function passLine(path: string, durationMs: number): string {
  return `PASS ${path} (${Math.round(durationMs)} ms)`
}

export function failLine(path: string): string {
  return `FAIL ${path}`
}

export function skipLine(path: string): string {
  return `SKIP ${path}`
}

/**
 * A failure's title line: the policy's bullet then the title. Without a bullet the title is
 * indented two spaces, so it still stands out from the file line above it.
 */
export function titleLine(report: ReportPolicy, title: string): string {
  return `${report.failureTitleBullet ?? '  '}${title}`
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

/** The stack's frame lines (`at …`), without the header V8 puts before them. */
function frames(error: SerializedError): string[] {
  return (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
}

/**
 * An error as text: its message, the stack's frames under it, then its cause and any errors it
 * aggregates, each nested one level deeper. Not indented; callers indent the block.
 */
export function formatError(error: SerializedError, depth = 0): string {
  const lines = [header(error), ...frames(error).map((frame) => `  ${frame}`)]
  if (depth < MAX_NESTING) {
    if (error.cause !== undefined) {
      lines.push('', 'Caused by:', indent(formatError(error.cause, depth + 1), 2))
    }
    for (const nested of error.errors ?? []) {
      lines.push('', 'Also:', indent(formatError(nested, depth + 1), 2))
    }
  }
  return lines.join('\n')
}

/** A titled block: the title line, then each error indented under it, then a blank line. */
export function failureBlock(
  report: ReportPolicy,
  title: string,
  errors: readonly SerializedError[],
): string {
  const body = errors.map((error) => indent(formatError(error), 4))
  return `${titleLine(report, title)}\n\n${body.join('\n\n')}\n`
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
export function snapshotLine(snapshots: SnapshotRunSummary | undefined): string | undefined {
  if (snapshots === undefined) return undefined
  const { counters } = snapshots
  if (counters.total === 0 && counters.unchecked === 0 && counters.filesRemoved === 0) {
    return undefined
  }
  const gone = snapshots.update === 'all' ? 'removed' : 'obsolete'
  const parts = [
    ...(counters.unmatched > 0 ? [part(counters.unmatched, 'failed')] : []),
    ...(counters.unchecked > 0 ? [part(counters.unchecked, gone)] : []),
    ...(counters.filesRemoved > 0
      ? [part(counters.filesRemoved, `${counters.filesRemoved === 1 ? 'file' : 'files'} ${gone}`)]
      : []),
    ...(counters.updated > 0 ? [part(counters.updated, 'updated')] : []),
    ...(counters.added > 0 ? [part(counters.added, 'written')] : []),
    ...(counters.matched > 0 ? [part(counters.matched, 'passed')] : []),
    part(counters.total, 'total'),
  ]
  return `Snapshots:   ${parts.join(', ')}`
}

/**
 * Jest's summary (`getSummary` in `@jest/reporters`): a count of zero is left out, `total` apart.
 * The suites' total reads `N of M total` whenever the suites that ran (failed plus passed: a
 * skipped file is not one that ran) differ from the files queued, as Jest's does. That is a run
 * that bailed (`1 of 3 total`) and a run with a skipped file (`1 skipped, 1 passed, 1 of 2 total`,
 * and `1 skipped, 0 of 1 total` for a project whose only file is skipped).
 */
export function summaryLines(
  files: FileCounts,
  tests: TestCounts,
  durationMs: number,
  snapshots?: string,
  queued = 0,
): string {
  const ran = files.failed + files.passed
  const suitesTotal = Math.max(queued, files.total)
  const suites = [
    ...(files.failed > 0 ? [part(files.failed, 'failed')] : []),
    ...(files.skipped > 0 ? [part(files.skipped, 'skipped')] : []),
    ...(files.passed > 0 ? [part(files.passed, 'passed')] : []),
    ran === suitesTotal ? part(suitesTotal, 'total') : `${ran} of ${suitesTotal} total`,
  ]
  const counted = [
    ...(tests.failed > 0 ? [part(tests.failed, 'failed')] : []),
    ...(tests.skipped > 0 ? [part(tests.skipped, 'skipped')] : []),
    ...(tests.todo > 0 ? [part(tests.todo, 'todo')] : []),
    ...(tests.passed > 0 ? [part(tests.passed, 'passed')] : []),
    part(tests.total, 'total'),
  ]
  return [
    `Test Suites: ${suites.join(', ')}`,
    `Tests:       ${counted.join(', ')}`,
    ...(snapshots === undefined ? [] : [snapshots]),
    `Time:        ${(durationMs / 1000).toFixed(3)} s`,
  ].join('\n')
}

/**
 * Jest's report of what a run left open (`--detectOpenHandles`): how many handles, then each one's
 * kind, a code frame around the line that made it, and the stack that made it. Handles with the
 * same stack are one entry whose kinds are joined by `,` (the collector does that).
 */
export function openHandlesText(handles: readonly OpenHandle[]): string {
  const count = `${handles.length} open handle${handles.length === 1 ? '' : 's'}`
  const blocks = handles.map((handle) => {
    const frames = handle.frames.map((frame) => `      ${frame}`).join('\n')
    const parts = [`  ●  ${handle.type}`]
    if (handle.codeFrame !== undefined) parts.push(indent(handle.codeFrame, 4))
    if (frames !== '') parts.push(frames)
    return `${parts.join('\n\n')}\n`
  })
  return `\nJest has detected the following ${count} potentially keeping Jest from exiting:\n\n${blocks.join('\n\n')}`
}
