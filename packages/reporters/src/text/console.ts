// A file's console output as text: Jest's `getConsoleOutput` (`@jest/console`), as far as the
// worker gives Provino what Jest has. Recorded from Jest 30.5.2 (`cli/report-default`): under the
// file's header, `  ● Console`, then for each call `    console.log`, its message indented two
// more, a blank line. Jest adds the call's `at` line, after a blank one, when it has the origin;
// the worker captures one when the policy's `orchestrator.consoleOrigin` is `stack` (Jest), else
// the events carry `origin: null` and a block has none.
import type { Style } from '../style.ts'
import { indent } from './format.ts'

/** One console call or direct stream write, as the bus reports it. */
export interface ConsoleEntry {
  readonly stream: 'stdout' | 'stderr'
  /** The console method (`log`, `warn`, ...), or `null` for a write to the stream itself. */
  readonly level: string | null
  readonly text: string
  /** Where the call was made (an `at ...` line, or a stack whose first frame is it), when known. */
  readonly origin: string | null
}

/** The first `at ...` frame of an origin, or `undefined`. */
function originFrame(origin: string | null): string | undefined {
  return origin
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at '))
}

/** A frame with the path of a file under `root` made relative to it. */
function relativeFrame(frame: string | undefined, root: string | undefined): string | undefined {
  if (frame === undefined || root === undefined || root === '') return frame
  return frame.replace(`${root.replace(/\/$/, '')}/`, '')
}

/** `console.log`, or `process.stdout` for a write that did not go through `console`. */
function entryTitle(entry: ConsoleEntry): string {
  return entry.level === null ? `process.${entry.stream}` : `console.${entry.level}`
}

/** What changes the entries' layout. */
export interface ConsoleFormat {
  /** Spaces before each title: 4 under the default reporter, 2 under `--verbose`. */
  readonly titleIndent: number
  /** Keep the `at` line of a `warn` or `error` entry; Jest's `--noStackTrace` leaves it out. */
  readonly stackTrace: boolean
  /** Paths under this directory are shown relative to it, as Jest's `formatPath` does. */
  readonly root?: string
}

/**
 * The entries as Jest lays them out: each title at `titleIndent` spaces, its message two more, then
 * the `at` line when there is an origin, and a blank line between entries. `warn` is yellow and
 * `error` red, as Jest colours them. The text ends with one newline.
 */
export function consoleEntries(
  entries: readonly ConsoleEntry[],
  format: ConsoleFormat,
  style: Style,
): string {
  const pad = ' '.repeat(format.titleIndent)
  const blocks = entries.map((entry) => {
    const colour =
      entry.level === 'warn' ? style.yellow : entry.level === 'error' ? style.red : undefined
    const message = indent(entry.text.trimEnd(), format.titleIndent + 2)
    const frame = relativeFrame(originFrame(entry.origin), format.root)
    const showFrame = frame !== undefined && (colour === undefined || format.stackTrace)
    return [
      `${pad}${(colour ?? style.dim)(entryTitle(entry))}`,
      colour === undefined ? message : colour(message),
      ...(showFrame ? ['', style.dim(`${pad}  ${frame}`)] : []),
    ].join('\n')
  })
  return `${blocks.join('\n\n')}\n`
}

/** The block the default reporter prints under a file's header: its bullet, then the entries. */
export function consoleBlock(
  entries: readonly ConsoleEntry[],
  style: Style,
  stackTrace: boolean,
  root?: string,
): string {
  return `  ${style.bold('● ')}Console\n\n${consoleEntries(entries, { titleIndent: 4, stackTrace, ...(root === undefined ? {} : { root }) }, style)}`
}
