// Expands a `projects` glob as `jest-config` does (`normalize.ts` L827-L854:
// `glob.sync(project, { windowsPathsNoEscape: true })`, glob 13.0.6), in the same order. glob 13
// doesn't sort: it walks with path-scurry, which lists a directory's entries in the reverse of
// `readdir`'s order (`#readdirAddNewChild` unshifts), takes literal segments without listing, and
// emits a level's matches before it walks deeper. This is that walk for the patterns configs use:
// literal, `*`, `?`, `[…]`, extglobs, `**` and braces, with glob's defaults (no dotfiles unless the
// segment starts with `.`, case-insensitive on macOS and Windows, a symlinked directory followed
// once by `**`). Braces expand as brace-expansion 5 does (`braces.ts`). Not ported: path-scurry's
// reordering of entries it saw before listing, and minimatch's later optimizations. No glob
// dependency (gap 12 of `bundles/B14.md`).
import { lstatSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { expandBraces } from './braces.ts'

const GLOBSTAR = Symbol('globstar')
type Segment = string | RegExp | typeof GLOBSTAR

const NOCASE = process.platform === 'darwin' || process.platform === 'win32'

function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')
}

/** One segment's regular expression, as minimatch builds it (`*`, `?`, classes, extglobs). */
function segmentSource(part: string): { readonly source: string; readonly magic: boolean } {
  let source = ''
  let magic = false
  let index = 0
  while (index < part.length) {
    const char = part[index] ?? ''
    const next = part[index + 1]
    if ('?*+@!'.includes(char) && next === '(') {
      const close = closingParen(part, index + 1)
      if (close !== -1) {
        const inner = splitTopLevelBars(part.slice(index + 2, close))
          .map((alternative) => segmentSource(alternative).source)
          .join('|')
        magic = true
        if (char === '!') source += `(?:(?!(?:${inner})$)[^/]*?)`
        else if (char === '@') source += `(?:${inner})`
        else if (char === '?') source += `(?:${inner})?`
        else if (char === '+') source += `(?:${inner})+`
        else source += `(?:${inner})*`
        index = close + 1
        continue
      }
    }
    if (char === '*') {
      magic = true
      source += '[^/]*?'
    } else if (char === '?') {
      magic = true
      source += '[^/]'
    } else if (char === '[') {
      const close = part.indexOf(']', index + 2)
      if (close === -1) source += '\\['
      else {
        let body = part.slice(index + 1, close)
        const negate = body.startsWith('!') || body.startsWith('^')
        if (negate) body = body.slice(1)
        source += `[${negate ? '^' : ''}${body.replaceAll(/[\\\]]/g, '\\$&')}]`
        magic = true
        index = close + 1
        continue
      }
    } else source += escapeRegExp(char)
    index++
  }
  return { source, magic }
}

function closingParen(part: string, open: number): number {
  let depth = 0
  for (let index = open; index < part.length; index++) {
    if (part[index] === '(') depth++
    else if (part[index] === ')') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevelBars(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === '|' && depth === 0) {
      out.push(body.slice(start, index))
      start = index + 1
    }
  }
  out.push(body.slice(start))
  return out
}

function toSegment(part: string): Segment {
  if (part === '**') return GLOBSTAR
  const { source, magic } = segmentSource(part)
  if (!magic) return part
  const dot = part.startsWith('.') ? '' : '(?!\\.)'
  return new RegExp(`^${dot}${source}$`, NOCASE ? 'i' : '')
}

interface Pattern {
  readonly segments: readonly Segment[]
  readonly absolute: boolean
  /** A symlinked directory a `**` here followed already (glob follows one). */
  followed: boolean
}

function parse(pattern: string): Pattern {
  const parts = pattern.split('/')
  const absolute = parts[0] === '' && parts.length > 1
  const body = absolute ? parts.slice(1) : parts
  const segments: Segment[] = []
  for (const part of body) {
    const segment = toSegment(part)
    if (segment === GLOBSTAR && segments.at(-1) === GLOBSTAR) continue
    segments.push(segment)
  }
  return { segments, absolute, followed: false }
}

interface Entry {
  readonly name: string
  readonly path: string
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
}

function lstatEntry(path: string): Entry | undefined {
  try {
    const stats = lstatSync(path)
    let isDirectory = stats.isDirectory()
    if (stats.isSymbolicLink()) {
      try {
        isDirectory = statSync(path).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    return {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      isDirectory,
      isSymbolicLink: stats.isSymbolicLink(),
    }
  } catch {
    return undefined
  }
}

/** path-scurry's listing: `readdir`'s entries, newest first (it unshifts each). */
function children(path: string): Entry[] {
  let names: string[]
  try {
    names = readdirSync(path)
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const name of names) {
    const entry = lstatEntry(resolve(path, name))
    if (entry !== undefined) out.unshift({ ...entry, name })
  }
  return out
}

function namesMatch(name: string, literal: string): boolean {
  return NOCASE ? name.toLowerCase() === literal.toLowerCase() : name === literal
}

interface Walk {
  readonly cwd: string
  readonly results: Set<string>
}

function emit(walk: Walk, path: string, absolute: boolean, ifDir: boolean): void {
  const entry = lstatEntry(path)
  if (entry === undefined || (ifDir && !entry.isDirectory)) return
  const shown = absolute ? path : relative(walk.cwd, path) || '.'
  walk.results.add(shown)
}

/** `processPatterns` + `walkCB2Sync`: literal segments resolved, then magic ones listed. */
function walkAt(walk: Walk, target: string, patterns: readonly Pattern[]): void {
  const matches: [string, boolean, boolean][] = []
  const subwalks = new Map<string, Pattern[]>()
  const addSubwalk = (path: string, pattern: Pattern): void => {
    const list = subwalks.get(path)
    if (list === undefined) subwalks.set(path, [pattern])
    else list.push(pattern)
  }
  for (const start of patterns) {
    let t = target
    let segments = start.segments
    if (segments.length === 0) {
      matches.push([t, start.absolute, false])
      continue
    }
    while (typeof segments[0] === 'string' && segments.length > 1) {
      t = resolve(t, segments[0])
      segments = segments.slice(1)
    }
    const head = segments[0]
    const pattern: Pattern = { ...start, segments }
    if (typeof head === 'string') {
      matches.push([resolve(t, head), start.absolute, head === '' || head === '.' || head === '..'])
    } else if (head === GLOBSTAR) {
      addSubwalk(t, pattern)
      const rest = segments.slice(1)
      if (rest.length === 0 || ((rest[0] === '' || rest[0] === '.') && rest.length === 1)) {
        matches.push([t, start.absolute, rest[0] === '' || rest[0] === '.'])
      }
    } else if (head !== undefined) {
      addSubwalk(t, pattern)
    }
  }
  for (const [path, absolute, ifDir] of matches) emit(walk, path, absolute, ifDir)
  for (const [path, list] of subwalks) walkEntries(walk, children(path), list)
}

/** `filterEntries` + `walkCB3Sync`: each entry against each pattern, this level's matches first. */
function walkEntries(walk: Walk, entries: readonly Entry[], patterns: readonly Pattern[]): void {
  const matches: [string, boolean][] = []
  const subwalks = new Map<string, Pattern[]>()
  const addSubwalk = (path: string, pattern: Pattern): void => {
    const list = subwalks.get(path)
    if (list === undefined) subwalks.set(path, [pattern])
    else list.push(pattern)
  }
  const test = (entry: Entry, segment: Segment, rest: readonly Segment[], pattern: Pattern) => {
    const hit =
      typeof segment === 'string'
        ? namesMatch(entry.name, segment)
        : segment !== GLOBSTAR && segment.test(entry.name)
    if (!hit) return
    if (rest.length === 0) matches.push([entry.path, pattern.absolute])
    else addSubwalk(entry.path, { ...pattern, segments: rest })
  }
  for (const entry of entries) {
    for (const pattern of patterns) {
      const [head, ...rest] = pattern.segments
      if (head === undefined) continue
      if (head !== GLOBSTAR) {
        test(entry, head, rest, pattern)
        continue
      }
      if (!entry.name.startsWith('.')) {
        if (rest.length === 0) matches.push([entry.path, pattern.absolute])
        if (entry.isDirectory) {
          if (!entry.isSymbolicLink) addSubwalk(entry.path, pattern)
          else if (!pattern.followed) addSubwalk(entry.path, { ...pattern, followed: true })
        }
      }
      const next = rest[0]
      if (next !== undefined && next !== '' && next !== '.' && next !== '..') {
        test(entry, next, rest.slice(1), pattern)
      }
    }
  }
  for (const [path, absolute] of matches) emit(walk, path, absolute, false)
  for (const [path, list] of subwalks) walkAt(walk, path, list)
}

/**
 * The paths a glob matches, in glob 13's order: absolute for an absolute pattern, else relative to
 * `cwd`. Backslashes are separators (`windowsPathsNoEscape`).
 * @internal
 */
export function globSync(pattern: string, cwd: string): string[] {
  const patterns = expandBraces(pattern.replaceAll('\\', '/')).map(parse)
  const walk: Walk = { cwd, results: new Set() }
  const absolute = patterns.filter((p) => p.absolute)
  const relativeOnes = patterns.filter((p) => !p.absolute)
  // glob mounts absolute patterns at the root and relative ones at `cwd`, in one walk.
  if (absolute.length > 0) walkAt(walk, '/', absolute)
  if (relativeOnes.length > 0) walkAt(walk, cwd, relativeOnes)
  return [...walk.results]
}
