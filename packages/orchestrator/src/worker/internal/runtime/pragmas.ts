// A test file's docblock pragmas (`@jest-environment jsdom`, `@jest-environment-options {...}`),
// read in the worker before the environment is chosen (R4). The grammar is jest-docblock 30.5's
// (`extract` then `parse`, with the regular expressions copied from its `index.ts`; `[^]` in
// `multilineRe` is written `[\s\S]`, the same set): the leading block comment only, `@name value`
// lines, a value wrapped over several lines, `//` comments dropped from values, and a repeated
// pragma as a list. The Jest dialect has its own copy (`@provino/dialect-jest/node`'s
// `parsePragmas`), because the worker is neutral and can't import a dialect; the two must agree.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { EOL } from 'node:os'
import type { Pragmas } from '@provino/types'

const commentEndRe = /\*\/$/
const commentStartRe = /^\/\*\*?/
const lineCommentRe = /(^|\s+)\/\/([^\n\r]*)/g
const ltrimNewlineRe = /^(\r?\n)+/
const multilineRe =
  /(?:^|\r?\n) *(@[^\n\r]*?) *\r?\n *(?![^\n\r@]*\/\/[\s\S]*)([^\s@][^\n\r@]+?) *\r?\n/g
const propertyRe = /(?:^|\r?\n) *@(\S+) *([^\n\r]*)/g
const stringStartRe = /(\r?\n|^) *\* ?/g
/** A character jest-docblock's `.` skips inside a comment: a carriage return not before `\n`, or a line separator. */
const notInComment = /\r(?!\n)|[\u2028\u2029]/

/** How much of a file is read first: nearly every docblock fits. */
const HEAD_BYTES = 4096

/**
 * The leading block comment, or `''`: `extract` in jest-docblock, without its lazy-alternation
 * regular expression (which backtracks over the whole comment): the first `*` + `/` after the
 * opening ends it. `undefined` when the comment is not closed in `source`.
 */
function extractDocblock(source: string): string | undefined {
  const start = source.length - source.trimStart().length
  if (source.charCodeAt(start) !== 0x2f || source.charCodeAt(start + 1) !== 0x2a) return ''
  const end = source.indexOf('*/', start + 2)
  if (end < 0) return undefined
  const comment = source.slice(start, end + 2)
  return notInComment.test(comment) ? '' : comment
}

/** `detect-newline` 3: the more common of `\r\n` and `\n`, or `undefined` for neither. */
function detectNewline(text: string): string | undefined {
  const newlines = text.match(/\r?\n/g) ?? []
  if (newlines.length === 0) return undefined
  const crlf = newlines.filter((newline) => newline === '\r\n').length
  return crlf > newlines.length - crlf ? '\r\n' : '\n'
}

/** `parse` in jest-docblock: the pragmas of a leading docblock. */
function parseDocblock(docblock: string): Pragmas {
  const line = detectNewline(docblock) ?? EOL
  let text = docblock
    .replace(commentStartRe, '')
    .replace(commentEndRe, '')
    .replaceAll(stringStartRe, '$1')
  let previous = ''
  while (previous !== text) {
    previous = text
    text = text.replaceAll(multilineRe, `${line}$1 $2${line}`)
  }
  text = text.replace(ltrimNewlineRe, '').trimEnd()
  const result: Record<string, string | readonly string[]> = Object.create(null)
  for (const match of text.matchAll(propertyRe)) {
    const name = match[1] ?? ''
    const value = (match[2] ?? '').replaceAll(lineCommentRe, '')
    const existing = result[name]
    result[name] =
      existing === undefined
        ? value
        : [...(typeof existing === 'string' ? [existing] : existing), value]
  }
  return result
}

/**
 * The pragmas of a file's docblock, by name without the `@`. A pragma with no value is `''`.
 * @internal
 */
export function parsePragmas(source: string): Pragmas {
  return parseDocblock(extractDocblock(source) ?? '')
}

/**
 * Reads `file`'s docblock pragmas from its first 4 KB, and from the whole file only when the
 * leading comment is still open there. A file that can't be read has none: the runner's own import
 * reports it.
 * @internal
 */
export function readPragmas(file: string): Pragmas {
  try {
    const head = Buffer.allocUnsafe(HEAD_BYTES)
    const fd = openSync(file, 'r')
    let length: number
    try {
      length = readSync(fd, head, 0, HEAD_BYTES, 0)
    } finally {
      closeSync(fd)
    }
    const text = head.toString('utf8', 0, length)
    const comment = extractDocblock(text)
    if (comment !== undefined && (length < HEAD_BYTES || text.trim() !== '')) {
      return parseDocblock(comment)
    }
    return parsePragmas(readFileSync(file, 'utf8'))
  } catch {
    return Object.create(null)
  }
}

/** The last value of a pragma (a repeated one: the last wins, as jest-runner's does), or `undefined`. */
export function pragmaValue(pragmas: Pragmas, name: string): string | undefined {
  const value = pragmas[name]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.at(-1)
}
