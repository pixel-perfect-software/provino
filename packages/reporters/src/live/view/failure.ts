// A failed test's block (its title path, the error's own text, where it happened and the code
// around it) and the loader that reads that code. Pure except the reader, which is asynchronous and
// bounded: the first 20 failing locations of a run, one read per source path for a file's failures,
// at most 1 MB a file (D148). The reporter never reads in a handler and never waits for a read in a
// frame past `CODE_FRAME_WAIT_MS`.

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SerializedError, SourceLocation } from '@provino/types'
import { posixRelative } from '../../internal/posix-relative.ts'
import { errorLocation } from '../../internal/views/location.ts'
import type { Style } from '../../style.ts'
import { formatError } from '../../text/format.ts'
import type { FailedTest } from '../model/state.ts'
import { hyperlink } from '../terminal/ansi.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { codeFrameLines, type Snippet, snippetAround } from './code-frame.ts'

/** The failing locations of a run that get a code frame. */
export const MAX_CODE_FRAMES: number = 20
/** The biggest source file that is read for a code frame, in bytes. */
export const MAX_SOURCE_BYTES: number = 1024 * 1024
/** How long a failure block waits for its source before it prints without. */
export const CODE_FRAME_WAIT_MS: number = 200
/** The longest error text one block shows, in characters. */
export const MAX_ERROR_TEXT: number = 16 * 1024
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
}

/** The test's title path, joined. */
export function titleOf(failure: FailedTest): string {
  return failure.title.join(TITLE_SEPARATOR)
}

/** Where a failed test failed: its first error's location, else the test's own. */
export function whereOf(failure: FailedTest): SourceLocation | undefined {
  const [first] = failure.errors
  return (first === undefined ? undefined : errorLocation(first)) ?? failure.location ?? undefined
}

/** A location's path as the run shows it: relative to `cwd` when inside it. */
export function displayFile(cwd: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file)
  const relative = posixRelative(cwd, absolute)
  return relative === '' || relative.startsWith('..') ? file : relative
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
  return text.split('\n').map((line) => (line === '' ? '' : pad + line))
}

/** Error text without its stack (the location line says where), capped. */
function errorsText(errors: readonly SerializedError[]): string {
  let text = errors.map((error) => formatError(error, false)).join('\n\n')
  if (text.length > MAX_ERROR_TEXT) text = `${text.slice(0, MAX_ERROR_TEXT)}\n… (cut at 16 KB)`
  return text
}

/**
 * A failed test's block: the title, the errors' text, the location, the code frame.
 * @beta
 */
export function failureLines(
  failure: FailedTest,
  context: FailureContext,
  snippet?: Snippet,
): string[] {
  const { style } = context
  const lines = [`   ${style.red('●')} ${style.bold(titleOf(failure))}`]
  lines.push(...indented(errorsText(failure.errors), 5))
  const where = whereOf(failure)
  if (where !== undefined) {
    lines.push(`     ${style.dim('›')} ${locationText(where, context)}`)
    if (snippet !== undefined) {
      const room = Math.max(10, context.columns - 1 - 5)
      for (const row of codeFrameLines(snippet, where.line, where.column, room, style)) {
        lines.push(`     ${row}`)
      }
    }
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
  return [`   ${style.red('●')} ${style.bold(title)}`, ...indented(errorsText(errors), 5), '']
}

/** One line that names a failure at the end of a run. */
export function failureSummaryLine(failure: FailedTest, context: FailureContext): string {
  const where = whereOf(failure)
  const place = where === undefined ? '' : `  ${context.style.dim(locationText(where, context))}`
  return `  ${context.glyphs.fail} ${titleOf(failure)}${place}`
}

/**
 * Reads a source file, as text, when it is a file of at most `MAX_SOURCE_BYTES`; `undefined` for
 * anything else, and for a file that can't be read.
 */
export async function readSourceCapped(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
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
        if (text === undefined || text.length > MAX_SOURCE_BYTES) return found
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
