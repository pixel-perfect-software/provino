// Brace expansion as glob 13 does it for a `projects` glob: minimatch 10.2.6's `braceExpand`
// shortcut, then brace-expansion 5.0.12's `expand` (`dist/esm/index.js`) over balanced-match
// 4.0.4's `balanced`, rebuilt step for step (MIT, as the rest of `node/`). Sets (`{a,b}`, nested),
// numeric and alphabetic sequences with zero-padding and steps (`{01..03}`, `{1..10..2}`,
// `{a..e..2}`, descending), `${…}` kept, empty members dropped at the top, and brace-expansion's
// limits on depth and rewrites. Where brace-expansion silently stops at 100,000 results, this
// throws instead (the one difference): a `projects` glob that large is a mistake, and glob would
// walk every one.
import { JestConfigError } from './errors.ts'

/** brace-expansion's `EXPANSION_MAX` and the other limits it applies. */
export const EXPANSION_MAX = 100_000
const EXPANSION_MAX_LENGTH = 4_000_000
const EXPANSION_MAX_DEPTH = 1_000
const EXPANSION_MAX_REWRITES = 1_000

// Escaped braces, commas and periods ride through as placeholders (brace-expansion adds a random
// number; a NUL can't be in a path, so a fixed one is as safe).
const escSlash = '\0SLASH\0'
const escOpen = '\0OPEN\0'
const escClose = '\0CLOSE\0'
const escComma = '\0COMMA\0'
const escPeriod = '\0PERIOD\0'

function escapeBraces(text: string): string {
  return text
    .replaceAll('\\\\', escSlash)
    .replaceAll('\\{', escOpen)
    .replaceAll('\\}', escClose)
    .replaceAll('\\,', escComma)
    .replaceAll('\\.', escPeriod)
}

function unescapeBraces(text: string): string {
  return text
    .replaceAll(escSlash, '\\')
    .replaceAll(escOpen, '{')
    .replaceAll(escClose, '}')
    .replaceAll(escComma, ',')
    .replaceAll(escPeriod, '.')
}

/** balanced-match 4's `range` for single-character delimiters: the outermost balanced pair. */
function range(text: string): [number, number] | undefined {
  let ai = text.indexOf('{')
  let bi = text.indexOf('}', ai + 1)
  let i = ai
  if (ai < 0 || bi <= 0) return undefined
  const begs: number[] = []
  let left = text.length
  let right: number | undefined
  let result: [number, number] | undefined
  while (i >= 0 && result === undefined) {
    if (i === ai) {
      begs.push(i)
      ai = text.indexOf('{', i + 1)
    } else if (begs.length === 1) {
      const start = begs.pop()
      if (start !== undefined) result = [start, bi]
    } else {
      const start = begs.pop()
      if (start !== undefined && start < left) {
        left = start
        right = bi
      }
      bi = text.indexOf('}', i + 1)
    }
    i = ai < bi && ai >= 0 ? ai : bi
  }
  if (begs.length > 0 && right !== undefined) result = [left, right]
  return result
}

interface Balanced {
  readonly pre: string
  readonly body: string
  readonly post: string
}

function balanced(text: string): Balanced | undefined {
  const found = range(text)
  if (found === undefined) return undefined
  const [start, end] = found
  return { pre: text.slice(0, start), body: text.slice(start + 1, end), post: text.slice(end + 1) }
}

/** `parseCommaParts`: `split(',')` that keeps nested braced sections whole. */
function parseCommaParts(body: string): string[] {
  const parts: string[] = []
  let carry = ''
  let rest = body
  for (;;) {
    const match = balanced(rest)
    if (match === undefined) {
      const tail = rest.split(',')
      tail[0] = carry + (tail[0] ?? '')
      parts.push(...tail)
      return parts
    }
    const pieces = match.pre.split(',')
    pieces[0] = carry + (pieces[0] ?? '')
    pieces[pieces.length - 1] += `{${match.body}}`
    if (match.post.length === 0) {
      parts.push(...pieces)
      return parts
    }
    carry = pieces.pop() ?? ''
    parts.push(...pieces)
    rest = match.post
  }
}

function numeric(text: string): number {
  return Number.isNaN(Number(text)) ? text.charCodeAt(0) : Number.parseInt(text, 10)
}

function combine(
  acc: readonly string[],
  pre: string,
  values: readonly string[],
  dropEmpties: boolean,
): string[] {
  const out: string[] = []
  let length = 0
  for (const head of acc) {
    for (const value of values) {
      if (out.length >= EXPANSION_MAX) return out
      const expansion = head + pre + value
      if (dropEmpties && !expansion) continue
      if (length + expansion.length > EXPANSION_MAX_LENGTH) return out
      out.push(expansion)
      length += expansion.length
    }
  }
  return out
}

/** `expandSequence`: `x..y[..step]`, padded when either end is (`/^-?0\d/`), to the wider width. */
function expandSequence(body: string, alphabetic: boolean): string[] {
  const parts = body.split('..')
  const out: string[] = []
  const [from, to, step] = parts
  if (from === undefined || to === undefined) return out
  const x = numeric(from)
  const y = numeric(to)
  const width = Math.max(from.length, to.length)
  let increment = step === undefined ? 1 : Math.max(Math.abs(numeric(step)), 1)
  const reverse = y < x
  if (reverse) increment *= -1
  const pad = parts.some((part) => /^-?0\d/.test(part))
  let length = 0
  for (let i = x; (reverse ? i >= y : i <= y) && out.length < EXPANSION_MAX; i += increment) {
    let value: string
    if (alphabetic) {
      value = String.fromCharCode(i)
      if (value === '\\') value = ''
    } else {
      value = String(i)
      const need = width - value.length
      if (pad && need > 0) {
        const zeros = '0'.repeat(need)
        value = i < 0 ? `-${zeros}${value.slice(1)}` : zeros + value
      }
    }
    if (length + value.length > EXPANSION_MAX_LENGTH) break
    out.push(value)
    length += value.length
  }
  return out
}

function expandFrom(text: string, depth: number, isTop: boolean): string[] {
  if (depth > EXPANSION_MAX_DEPTH) return [text]
  let acc = ['']
  let rest = text
  let top = isTop
  let rewrites = 0
  let dropEmpties = false
  let firstGroup = true
  for (;;) {
    const match = balanced(rest)
    if (match === undefined) return combine(acc, rest, [''], dropEmpties)
    const { pre, body, post } = match
    if (pre.endsWith('$')) {
      acc = combine(acc, `${pre}{${body}}`, [''], dropEmpties && post.length === 0)
      firstGroup = false
      if (post.length === 0) break
      rest = post
      continue
    }
    const numericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(body)
    const alphabeticSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(body)
    const sequence = numericSequence || alphabeticSequence
    const options = body.includes(',')
    if (!sequence && !options) {
      // `{a}b,c}`: rewrite so the inner `}` is literal and the outer pair is a set.
      if (rewrites < EXPANSION_MAX_REWRITES && /,(?!,).*\}/.test(post)) {
        rewrites++
        rest = `${pre}{${body}${escClose}${post}`
        top = true
        continue
      }
      return combine(acc, `${pre}{${body}}${post}`, [''], dropEmpties)
    }
    if (firstGroup) {
      dropEmpties = top && !sequence
      firstGroup = false
    }
    let values: string[]
    if (sequence) {
      values = expandSequence(body, alphabeticSequence)
    } else {
      let parts = parseCommaParts(body)
      if (parts.length === 1 && parts[0] !== undefined) {
        parts = expandFrom(parts[0], depth + 1, false).map((part) => `{${part}}`)
        if (parts.length === 1) {
          acc = combine(acc, pre + (parts[0] ?? ''), [''], dropEmpties && post.length === 0)
          if (post.length === 0) break
          rest = post
          continue
        }
      }
      let dropsEmpties = dropEmpties && post.length === 0 && !pre
      if (acc.some((head) => head !== '')) dropsEmpties = false
      values = []
      let valuesLength = 0
      outer: for (const part of parts) {
        for (const value of expandFrom(part, depth + 1, false)) {
          if (dropsEmpties && !value) continue
          if (
            values.length >= EXPANSION_MAX ||
            valuesLength + value.length > EXPANSION_MAX_LENGTH
          ) {
            break outer
          }
          values.push(value)
          valuesLength += value.length
        }
      }
    }
    acc = combine(acc, pre, values, dropEmpties && post.length === 0)
    if (post.length === 0) break
    rest = post
  }
  return acc
}

/**
 * The patterns a glob's braces expand to, as minimatch 10.2.6 gives them to glob 13. Throws
 * `JestConfigError` (`JEST_CONFIG_INVALID`) at brace-expansion's 100,000-result limit.
 * @internal
 */
export function expandBraces(pattern: string): string[] {
  // minimatch's shortcut: no `{…}` with no `{` inside means nothing to expand.
  if (!/\{(?:(?!\{).)*\}/.test(pattern)) return [pattern]
  const source = pattern.startsWith('{}') ? `\\{\\}${pattern.slice(2)}` : pattern
  const expanded = expandFrom(escapeBraces(source), 0, true).map(unescapeBraces)
  if (expanded.length >= EXPANSION_MAX) {
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      `the projects glob "${pattern}" expands to ${EXPANSION_MAX} patterns or more; brace-expansion stops there, and glob would walk every one`,
    )
  }
  return expanded
}
