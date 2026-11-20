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
  let depth = 0
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] as string
    if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else if (char === '{') {
      depth++
      out += '(?:'
    } else if (char === '}' && depth > 0) {
      depth--
      out += ')'
    } else if (char === ',' && depth > 0) out += '|'
    else if (char === '[') {
      const end = segment.indexOf(']', index + 1)
      if (end === -1) out += '\\['
      else {
        out += segment.slice(index, end + 1)
        index = end
      }
    } else out += SPECIAL.test(char) ? `\\${char}` : char
  }
  return out + ')'.repeat(depth)
}

/**
 * A root-relative glob (`**\/node_modules/**`) as the source of a regular expression that matches
 * the absolute path of a file it names under `root`, as `NeutralDiscovery.excludePatterns` wants.
 * @public
 */
export function globToRegexSource(glob: string, root: string): string {
  const segments = glob.replace(/^\.\//, '').split('/')
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
  out = out.replace(/\/\(\?:\.\*\)\?$/, '(?:/.*)?')
  return `^${escapeRegex(root.split(sep).join('/'))}/${out}$`
}

/** A glob's segments as regular expressions, for walking. */
function matcher(segment: string): RegExp {
  return new RegExp(`^${segmentSource(segment)}$`)
}

const SKIPPED = new Set(['node_modules', '.git'])

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
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
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
    if (!test.test(entry.name)) continue
    if (rest.length > 0 && !entry.isDirectory()) continue
    await walk(join(base, entry.name), rest, found)
  }
}

/**
 * The paths under `root` that `patterns` name, sorted: a pattern is a path or a glob relative to
 * `root`, `**` crosses directories (never `node_modules` or `.git`), and one that starts with
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
    const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
    await walk(resolve(root), clean === '' ? [] : clean.split('/'), found)
  }
  return [...found]
    .filter((path) => !negated.some((regex) => regex.test(path.split(sep).join('/'))))
    .sort()
}

/** The path from `root`, POSIX. */
export function relativeTo(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}
