// A failed test's block (its title path, the error's own text, where it happened, the code around
// it and a short call chain) and the loader that reads that code. Pure except the reader, which is
// asynchronous and bounded: the first 20 failing locations of a run, one read per source path for a
// file's failures, at most 1 MB a file read through one handle (D148). The reporter never reads in a
// handler and never waits for a read in a frame past `CODE_FRAME_WAIT_MS`.

import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SerializedError, SourceLocation } from '@provino/types'
import { posixRelative } from '../../internal/posix-relative.ts'
import { frameLocation } from '../../internal/views/location.ts'
import type { Style } from '../../style.ts'
import { formatError, frames } from '../../text/format.ts'
import type { FailedTest } from '../model/state.ts'
import { hyperlink } from '../terminal/ansi.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { cleanText } from '../terminal/sanitize.ts'
import { fitWidth } from '../terminal/width.ts'
import { codeFrameLines, type Snippet, snippetAround } from './code-frame.ts'

/** The failing locations of a run that get a code frame. */
export const MAX_CODE_FRAMES: number = 20
/** The biggest source file that is read for a code frame, in bytes. */
export const MAX_SOURCE_BYTES: number = 1024 * 1024
/** How long a failure block waits for its source before it prints without. */
export const CODE_FRAME_WAIT_MS: number = 200
/** The longest error text one block shows, in characters. */
export const MAX_ERROR_TEXT: number = 16 * 1024
/** The user frames shown under a code frame; the rest are counted. */
export const MAX_STACK_FRAMES: number = 5
/** The separator of a test's title path. The reporter's own: it reads no policy. */
export const TITLE_SEPARATOR: string = ' › '

/**
 * What a block needs to be drawn.
 * @beta
 */
export interface FailureContext {
  readonly glyphs: Glyphs
  readonly style: Style
  readonly columns: number
  readonly hyperlinks: boolean
  /** The run's root: paths show relative to it, and links point inside it. */
  readonly cwd: string
  /** Colour is drawn: SGR sequences in a test's text stay (they are dropped otherwise). */
  readonly colour: boolean
}

/**
 * Where a failure happened and the user frames of its call chain, worked out once.
 * @beta
 */
export interface FailurePlace {
  readonly where: SourceLocation | undefined
  /** Up to `MAX_STACK_FRAMES` user frames after the located one, paths relative to the root. */
  readonly frames: readonly string[]
  /** User frames past those. */
  readonly framesMore: number
}

/** A failure with no location and no frames (`noStackTrace`, or nothing to point at). */
export const NO_PLACE: FailurePlace = { where: undefined, frames: [], framesMore: 0 }

/** The test's title path, joined, with control characters dropped. */
export function titleOf(failure: FailedTest): string {
  return cleanText(failure.title.join(TITLE_SEPARATOR), false)
}

/** A location's path as the run shows it: relative to `cwd` when inside it. */
export function displayFile(cwd: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file)
  const relative = posixRelative(cwd, absolute)
  if (relative === '' || relative === '..' || relative.startsWith('../') || isAbsolute(relative)) {
    return file
  }
  return relative
}

/** `frame` with the file's path made relative to `cwd` (a `file://` URL included). */
function relativeFrame(frame: string, cwd: string): string {
  const found = frameLocation(frame)
  if (found === undefined) return frame
  const shown = displayFile(cwd, found.file)
  if (shown === found.file) return frame
  return frame.replace(`file://${found.file}`, shown).replace(found.file, shown)
}

/**
 * Where a failed test failed and the user frames of its first error (a library's, Node's and
 * Provino's own frames left out, as the default reporter leaves them): the error's own location,
 * else the first user frame, else the test's. Scans the stack once; call it once per failure.
 * @beta
 */
export function placeOf(failure: FailedTest, cwd: string): FailurePlace {
  const [first] = failure.errors
  const list = first === undefined ? [] : frames(first)
  let where = first?.location
  if (where === undefined) {
    for (const frame of list) {
      where = frameLocation(frame)
      if (where !== undefined) break
    }
  }
  where ??= failure.location ?? undefined
  const rest = list.filter((frame) => {
    const found = frameLocation(frame)
    return !(
      found !== undefined &&
      where !== undefined &&
      found.file === where.file &&
      found.line === where.line &&
      found.column === where.column
    )
  })
  return {
    where,
    frames: rest.slice(0, MAX_STACK_FRAMES).map((frame) => relativeFrame(frame, cwd)),
    framesMore: Math.max(0, rest.length - MAX_STACK_FRAMES),
  }
}

/** `path:line:col`, a hyperlink to the file where the terminal draws them. */
export function locationText(location: SourceLocation, context: FailureContext): string {
  const text = `${displayFile(context.cwd, location.file)}:${location.line}:${location.column}`
  if (!context.hyperlinks) return text
  const absolute = isAbsolute(location.file) ? location.file : resolve(context.cwd, location.file)
  return hyperlink(pathToFileURL(absolute).href, text)
}

function indented(text: string, spaces: number): string[] {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map((line) => (line === '' ? line : pad + line))
}

/** Error text without its stack (the location says where), cleaned, capped. */
function errorsText(errors: readonly SerializedError[], colour: boolean): string {
  let text = errors.map((error) => formatError(error, false)).join('\n\n')
  if (text.length > MAX_ERROR_TEXT) text = `${text.slice(0, MAX_ERROR_TEXT)}\n… (cut at 16 KB)`
  return cleanText(text, colour)
}

/**
 * A failed test's block: the title, the errors' text, the location, the code frame and the call
 * chain. With no `place.where` there is no location line and no frame.
 * @beta
 */
export function failureLines(
  failure: FailedTest,
  place: FailurePlace,
  context: FailureContext,
  snippet?: Snippet,
): string[] {
  const { style } = context
  const room = Math.max(10, context.columns - 1 - 5)
  const lines = [`   ${style.red('●')} ${style.bold(titleOf(failure))}`]
  lines.push(...indented(errorsText(failure.errors, context.colour), 5))
  const { where } = place
  if (where !== undefined) {
    lines.push(`     ${style.dim('›')} ${locationText(where, context)}`)
    if (snippet !== undefined) {
      for (const row of codeFrameLines(snippet, where.line, where.column, room, style)) {
        lines.push(`     ${row}`)
      }
    }
    for (const frame of place.frames) lines.push(`     ${style.dim(fitWidth(frame, room))}`)
    if (place.framesMore > 0) lines.push(`     ${style.dim(`… ${place.framesMore} more`)}`)
  }
  lines.push('')
  return lines
}

/** An error outside the tests (a file that did not run, an unhandled error): the title, then its text. */
export function errorBlockLines(
  title: string,
  errors: readonly SerializedError[],
  context: FailureContext,
): string[] {
  const { style } = context
  return [
    `   ${style.red('●')} ${style.bold(cleanText(title, false))}`,
    ...indented(errorsText(errors, context.colour), 5),
    '',
  ]
}

/** One line that names a failure at the end of a run. */
export function failureSummaryLine(
  failure: FailedTest,
  place: FailurePlace,
  context: FailureContext,
): string {
  const where = place.where
  const spot = where === undefined ? '' : `  ${context.style.dim(locationText(where, context))}`
  return `  ${context.glyphs.fail} ${titleOf(failure)}${spot}`
}

/**
 * Reads a source file as text through one handle: a regular file (checked after the open), and no
 * more than `MAX_SOURCE_BYTES` bytes whatever its size says or becomes. `undefined` for anything
 * else, a file over the cap included, and for a file that can't be read.
 */
export async function readSourceCapped(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined
    const buffer = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > MAX_SOURCE_BYTES ? undefined : buffer.toString('utf8', 0, length)
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Whether `text` is over the cap in bytes (UTF-8), not in characters. */
function overCap(text: string): boolean {
  if (text.length > MAX_SOURCE_BYTES) return true
  return text.length * 3 > MAX_SOURCE_BYTES && Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES
}

/**
 * The reader behind the code frames.
 * @beta
 */
export interface SnippetLoader {
  /**
   * Starts the reads for a file's failing `locations`: one read per source path, and none for a
   * location past the run's `MAX_CODE_FRAMES`. Resolves a map from `path:line` (the location's own
   * `file` text) to the snippet; `undefined` when no location was granted a read. Never rejects.
   */
  load(locations: readonly SourceLocation[]): Promise<ReadonlyMap<string, Snippet>> | undefined
  /** How many locations have been granted a read. */
  readonly granted: () => number
  /** A new run: the budget starts over. */
  reset(): void
}

/** The key a location's snippet is stored under. */
export function snippetKey(location: SourceLocation): string {
  return `${location.file}:${location.line}`
}

/**
 * Creates the loader. `read` is how a source file is read (`readSourceCapped`, or a test's stub).
 * @beta
 */
export function createSnippetLoader(options: {
  readonly cwd: string
  readonly read: (path: string) => Promise<string | undefined>
  readonly max?: number
}): SnippetLoader {
  const max = options.max ?? MAX_CODE_FRAMES
  let granted = 0
  return {
    load(locations) {
      const byPath = new Map<string, SourceLocation[]>()
      for (const location of locations) {
        if (granted >= max) break
        granted++
        const group = byPath.get(location.file)
        if (group === undefined) byPath.set(location.file, [location])
        else group.push(location)
      }
      if (byPath.size === 0) return undefined
      const reads = [...byPath].map(async ([file, wanted]) => {
        const absolute = isAbsolute(file) ? file : resolve(options.cwd, file)
        let text: string | undefined
        try {
          text = await options.read(absolute)
        } catch {
          text = undefined
        }
        const found: [string, Snippet][] = []
        if (text === undefined || overCap(text)) return found
        for (const location of wanted) {
          const snippet = snippetAround(text, location.line)
          if (snippet !== undefined) found.push([snippetKey(location), snippet])
        }
        return found
      })
      return Promise.all(reads).then((all) => new Map(all.flat()))
    },
    granted: () => granted,
    reset() {
      granted = 0
    },
  }
}
