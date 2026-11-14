// The text reporters' strings, all in one place (`default`, `verbose`, `agent`, and the failure
// blocks `dot` ends with). Jest's wording where it was recorded from Jest 30.5.2 (`cli/report-*`:
// the header line, the verbose list, the console block, the totals), Provino's own elsewhere (the
// failure message, which has Provino's frames).
import { fileURLToPath } from 'node:url'
import type {
  FileInfo,
  LazyEvaluation,
  OpenHandle,
  ReportPolicy,
  SerializedError,
  SnapshotRunSummary,
} from '@provino/types'
import { posixRelative } from '../internal/posix-relative.ts'
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
  // Most messages are one line: no split, no join.
  if (!text.includes('\n')) return text === '' ? text : pad + text
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

/** `ms` as seconds with three decimals, never negative: the Time line's, the JUnit schema's `time`. */
export function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

/** A file's name with its project before it: `server ./a.test.ts`, or just the path for a project with no name. */
export function projectLabel(file: FileInfo, path: string): string {
  return file.project === '' ? path : `${file.project} ${path}`
}

/** `(7.2 s)`, for a slow file, as Jest's `formatTime(runtime, 0)` writes it; `''` for any other. */
function slowDetail(durationMs: number, style: Style): string {
  if (durationMs <= SLOW_FILE_MS) return ''
  return ` (${style.red(`${Number(seconds(durationMs))} s`)})`
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
 * The directory that holds Provino's own packages when this code runs from a workspace checkout
 * (`<repo>/packages/`, from the built umbrella's `packages/provino/dist` as well as a package's
 * `src`); `undefined` from an install, where Provino sits under `node_modules` and its frames are
 * hidden as a dependency's are (D104: both runners hide their own internals). Decoded, as stack
 * frames are: `import.meta.url` is percent-encoded.
 */
const PROVINO_PACKAGES: string | undefined = (() => {
  try {
    const path = fileURLToPath(import.meta.url).replaceAll('\\', '/')
    return /^(.*\/packages\/)[^/]+\/(?:src|dist)\//.exec(path)?.[1]
  } catch {
    return undefined
  }
})()

/**
 * Whether a frame is in one of Provino's own packages: `<packages>/<name>/src|dist/` of this
 * checkout (a test, a fixture or a project that sits under `packages/` is the user's), or an
 * installed `node_modules/provino` or `node_modules/@provino/<name>`. `file://` frames keep their
 * percent-encoding, so both the line and its decoded form are looked at.
 * @internal
 */
export function isProvinoFrame(frame: string, packages: string | undefined): boolean {
  let decoded = frame
  try {
    decoded = decodeURI(frame)
  } catch {
    // A literal `%` that is no escape: the line as it is.
  }
  for (const text of new Set([frame, decoded].map((line) => line.replaceAll('\\', '/')))) {
    if (/\/node_modules\/(?:provino|@provino\/[^/]+)\//.test(text)) return true
    if (packages === undefined) continue
    const at = text.indexOf(packages)
    if (at !== -1 && /^[^/]+\/(?:src|dist)\//.test(text.slice(at + packages.length))) return true
  }
  return false
}

/**
 * Whether a frame is Node's or a dependency's, as Jest's `removeInternalStackEntries` has it:
 * `node:` internals and anything under `node_modules` say nothing about the user's code.
 */
function isLibraryFrame(frame: string): boolean {
  return (
    frame.includes('node:') ||
    frame.includes('node_modules') ||
    isProvinoFrame(frame, PROVINO_PACKAGES)
  )
}

/** The stack's frame lines (`at …`), without the header V8 puts before them or a library's frames. */
export function frames(error: SerializedError): string[] {
  return (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !isLibraryFrame(line))
}

/**
 * An error as text: its message, the stack's frames under it (a library's left out; none with
 * `stackTrace` off, Jest's `--noStackTrace`), then its cause and any errors it aggregates, each
 * nested one level deeper. Not indented; callers indent the block.
 */
export function formatError(error: SerializedError, stackTrace = true, depth = 0): string {
  const shown = stackTrace ? frames(error) : []
  const lines = [header(error), ...shown.map((frame) => `  ${frame}`)]
  if (depth < MAX_NESTING) {
    if (error.cause !== undefined) {
      lines.push('', 'Caused by:', indent(formatError(error.cause, stackTrace, depth + 1), 2))
    }
    for (const nested of error.errors ?? []) {
      lines.push('', 'Also:', indent(formatError(nested, stackTrace, depth + 1), 2))
    }
  }
  return lines.join('\n')
}

/** Several errors as text, a blank line apart. */
export function formatErrors(errors: readonly SerializedError[], stackTrace = true): string {
  return errors.map((error) => formatError(error, stackTrace)).join('\n\n')
}

/** A titled block: the title line, then each error indented under it, then a blank line. */
export function failureBlock(
  report: ReportPolicy,
  title: string,
  errors: readonly SerializedError[],
  style: Style,
  stackTrace = true,
): string {
  return `${titleLine(report, title, style)}\n\n${indent(formatErrors(errors, stackTrace), 4)}\n`
}

/** A lazy value's time: `<1 ms` under a millisecond, else whole milliseconds. */
function lazyMs(ms: number): string {
  return ms < 1 ? '<1 ms' : `${Math.round(ms)} ms`
}

/** A definition's site as the run's own paths read: relative to `root` when it is under it. */
function lazySite(root: string, site: LazyEvaluation['site']): string {
  const path = posixRelative(root, site.file)
  const shown = path === '' || path.startsWith('..') ? site.file : path
  return `${shown}:${site.line}:${site.column}`
}

/**
 * The lazy values a failed test evaluated (T6.10), in the order they finished, each with where it
 * is defined and how long it took, then the chain of a definition that threw (`cart -> user`: reading
 * `cart` read `user`, which threw). Ends with a blank line, to follow a `failureBlock`; `''` for
 * none.
 */
export function lazyBlock(
  lazies: readonly LazyEvaluation[] | undefined,
  root: string,
  style: Style,
): string {
  if (lazies === undefined || lazies.length === 0) return ''
  const lines = [`Lazy values evaluated before the failure:`]
  const chains = new Set<string>()
  for (const lazy of lazies) {
    const note = `${lazy.override ? ' (override)' : ''}${lazy.failed ? ` ${style.red('threw')}` : ''}`
    lines.push(
      `  ${lazy.key}${note}  ${style.dim(`${lazySite(root, lazy.site)}  ${lazyMs(lazy.ms)}`)}`,
    )
    if (lazy.failed && lazy.chain !== undefined && lazy.chain.length > 1) {
      chains.add(lazy.chain.join(' -> '))
    }
  }
  for (const chain of chains) lines.push(`  chain: ${chain}`)
  return `\n${indent(lines.join('\n'), 4)}\n`
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
  always = false,
): string | undefined {
  if (snapshots === undefined) {
    return always ? `${style.bold('Snapshots:')}   0 total` : undefined
  }
  const { counters } = snapshots
  if (!always && counters.total === 0 && counters.unchecked === 0 && counters.filesRemoved === 0) {
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
    `${bold('Time:')}        ${seconds(durationMs)} s`,
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
