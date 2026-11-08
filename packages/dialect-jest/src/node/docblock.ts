// The pragmas of a file's leading docblock, as `jest-docblock` 30.5.0 reads them (`index.ts`
// L14-L80: `extract` then `parse`, with the regular expressions copied from there; `[^]` in
// `multilineRe` is written `[\s\S]`, the same set, for Biome). The config loader reads
// `@jest-config-loader` and `@jest-config-loader-options` with it.
import { EOL } from 'node:os'

const commentEndRe = /\*\/$/
const commentStartRe = /^\/\*\*?/
const docblockRe = /^\s*(\/\*\*?(.|\r?\n)*?\*\/)/
const lineCommentRe = /(^|\s+)\/\/([^\n\r]*)/g
const ltrimNewlineRe = /^(\r?\n)+/
const multilineRe =
  /(?:^|\r?\n) *(@[^\n\r]*?) *\r?\n *(?![^\n\r@]*\/\/[\s\S]*)([^\s@][^\n\r@]+?) *\r?\n/g
const propertyRe = /(?:^|\r?\n) *@(\S+) *([^\n\r]*)/g
const stringStartRe = /(\r?\n|^) *\* ?/g

/** A docblock's pragmas: a name given twice or more holds every value. */
export type Pragmas = Readonly<Record<string, string | readonly string[]>>

/** `detect-newline` 3: the more common of `\r\n` and `\n`, or `undefined` for neither. */
function detectNewline(text: string): string | undefined {
  const newlines = text.match(/\r?\n/g) ?? []
  if (newlines.length === 0) return undefined
  const crlf = newlines.filter((newline) => newline === '\r\n').length
  return crlf > newlines.length - crlf ? '\r\n' : '\n'
}

/** `extract`: the leading docblock, or `''`. */
export function extractDocblock(contents: string): string {
  const match = contents.match(docblockRe)
  return match ? match[0].trimStart() : ''
}

/** `parse`: the pragmas of a docblock `extractDocblock` returned. */
export function parsePragmas(docblock: string): Pragmas {
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
