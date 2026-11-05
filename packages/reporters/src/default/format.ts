// The default reporter's text, all in one place. It is Jest-like, not a golden: T9.7 records the
// real format and decides what to match.
import type { ReportPolicy, SerializedError } from '@provino/types'

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

/** Jest's summary: zero parts are left out except `passed` and `total`. */
export function summaryLines(files: FileCounts, tests: TestCounts, durationMs: number): string {
  const suites = [
    ...(files.failed > 0 ? [part(files.failed, 'failed')] : []),
    ...(files.skipped > 0 ? [part(files.skipped, 'skipped')] : []),
    part(files.passed, 'passed'),
    part(files.total, 'total'),
  ]
  const counted = [
    ...(tests.failed > 0 ? [part(tests.failed, 'failed')] : []),
    ...(tests.skipped > 0 ? [part(tests.skipped, 'skipped')] : []),
    ...(tests.todo > 0 ? [part(tests.todo, 'todo')] : []),
    part(tests.passed, 'passed'),
    part(tests.total, 'total'),
  ]
  return [
    `Test Suites: ${suites.join(', ')}`,
    `Tests:       ${counted.join(', ')}`,
    `Time:        ${(durationMs / 1000).toFixed(3)} s`,
  ].join('\n')
}
