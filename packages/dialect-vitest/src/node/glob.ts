// B25c: the two glob jobs the reader has, with no glob dependency: a `test.projects` entry that
// names directories or config files (found by walking the root), and a `test.exclude` glob turned
// into the regular expression `NeutralDiscovery.excludePatterns` holds.
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const SPECIAL = /[.+^$()|\\[\]{}*?]/

/** Whether `text` has a glob character. */
export function isGlob(text: string): boolean {
  return /[*?{}[\]!]/.test(text)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One path segment's glob as a regular expression source (no `/` in it). */
function segmentSource(segment: string): string {
  let out = ''
  // What each open group closes with: `{a,b}` closes with `)`, an extglob `?(a|b)` with `)?`.
  const closers: string[] = []
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] as string
    const next = segment[index + 1]
    if ('?*+@'.includes(char) && next === '(') {
      out += '(?:'
      closers.push(char === '?' ? ')?' : char === '*' ? ')*' : char === '+' ? ')+' : ')')
      index++
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else if (char === '{') {
      closers.push(')')
      out += '(?:'
    } else if ((char === '}' || char === ')') && closers.length > 0) {
      out += closers.pop() as string
    } else if (char === ',' && closers.length > 0) out += '|'
    else if (char === '|' && closers.length > 0) out += '|'
    else if (char === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close === -1) out += '\\['
      else {
        const body = segment.slice(index + 1, close)
        // `[!ab]` is "not a or b" in a glob and `[^ab]` in a regular expression.
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        index = close
      }
    } else out += SPECIAL.test(char) ? `\\${char}` : char
  }
  return out + closers.reverse().join('')
}

/**
 * The patterns a pattern's braces stand for (`{a/b,c}/x` is `a/b/x` and `c/x`), nested braces
 * included, so a slash inside a brace is cut after the expansion, not before it.
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  let depth = 0
  let close = -1
  const cuts: number[] = []
  for (let index = open; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        close = index
        break
      }
    } else if (char === ',' && depth === 1) cuts.push(index)
  }
  // A brace with no comma (`{a}`) or no end is literal text.
  if (close === -1 || cuts.length === 0) {
    return expandBraces(pattern.slice(open + 1)).map((tail) => pattern.slice(0, open + 1) + tail)
  }
  const edges = [open, ...cuts, close]
  const alternatives = edges.slice(0, -1).map((start, i) => pattern.slice(start + 1, edges[i + 1]))
  const tails = expandBraces(pattern.slice(close + 1))
  return alternatives.flatMap((alternative) =>
    expandBraces(alternative).flatMap((inner) =>
      tails.map((tail) => pattern.slice(0, open) + inner + tail),
    ),
  )
}

/**
 * A root-relative glob (`**\/node_modules/**`) as the source of a regular expression that matches
 * the absolute path of a file it names under `root`, as `NeutralDiscovery.excludePatterns` wants.
 * @public
 */
export function globToRegexSource(glob: string, root: string): string {
  const sources = expandBraces(glob).map((pattern) => patternSource(pattern))
  const body = sources.length === 1 ? (sources[0] as string) : '(?:' + sources.join('|') + ')'
  return '^' + escapeRegex(root.split(sep).join('/')) + '/' + body + '$'
}

/** One brace-free pattern as a regular expression source, without its anchors. */
function patternSource(pattern: string): string {
  const segments = pattern.replace(/^\.\//, '').split('/')
  let out = ''
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] as string
    const last = index === segments.length - 1
    if (segment === '**') {
      out += last ? '(?:.*)?' : '(?:.*/)?'
      continue
    }
    out += segmentSource(segment)
    if (!last) out += '/'
  }
  // `a/**` leaves `a/` then `(?:.*)?`: the directory itself and everything under it.
  return out.replace(/\/\(\?:\.\*\)\?$/, '(?:/.*)?')
}

/** A glob's segments as regular expressions, for walking. */
function matcher(segment: string): RegExp {
  return new RegExp(`^${segmentSource(segment)}$`)
}

/**
 * What Vitest's project glob leaves out (tinyglobby with `dot: true` and its `ignore` list):
 * `node_modules`, a bundled config's `*.timestamp-*` and macOS's `.DS_Store`. Dot entries match.
 */
function ignored(name: string): boolean {
  return name === 'node_modules' || name === '.DS_Store' || name.includes('.timestamp-')
}

async function walk(base: string, segments: readonly string[], found: Set<string>): Promise<void> {
  const [head, ...rest] = segments
  if (head === undefined) {
    found.add(base)
    return
  }
  if (head === '**') {
    await walk(base, rest, found)
    const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && !ignored(entry.name)) {
        await walk(join(base, entry.name), segments, found)
      }
    }
    return
  }
  if (!isGlob(head)) {
    const next = join(base, head)
    if (
      await stat(next).then(
        () => true,
        () => false,
      )
    )
      await walk(next, rest, found)
    return
  }
  const test = matcher(head)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!test.test(entry.name) || ignored(entry.name)) continue
    if (rest.length > 0 && !entry.isDirectory()) continue
    await walk(join(base, entry.name), rest, found)
  }
}

/**
 * The paths under `root` that `patterns` name, sorted: a pattern is a path or a glob relative to
 * `root`, `**` crosses directories (never `node_modules`; dot entries match, as tinyglobby's `dot: true`), and one that starts with
 * `!` removes what it matches from the others, as `test.projects` globs do.
 * @public
 */
export async function expandGlobs(root: string, patterns: readonly string[]): Promise<string[]> {
  const found = new Set<string>()
  const negated: RegExp[] = []
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      negated.push(new RegExp(globToRegexSource(pattern.slice(1), root)))
      continue
    }
    for (const expanded of expandBraces(pattern)) {
      const clean = expanded.replace(/^\.\//, '').replace(/\/+$/, '')
      await walk(resolve(root), clean === '' ? [] : clean.split('/'), found)
    }
  }
  return [...found]
    .filter((path) => !negated.some((regex) => regex.test(path.split(sep).join('/'))))
    .sort()
}

/** The path from `root`, POSIX. */
export function relativeTo(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}
