// What the Vitest config sample compares (B25c, T11.15, D28's terms): the reader's `test` against
// `vitest/node`'s `resolveConfig(...).test`, on the 30 `test.*` keys Track 11 F4 ranks highest
// among Vitest repositories. Both sides are encoded the same way (`../jest-config/compare.ts`'s
// `encode`: functions as their source, `RegExp` as source and flags, `undefined` kept).
//
// A key is compared when the config sets it: it names the key, or Vitest's plain value differs from
// what Vitest resolves for an empty directory (`defaults`). Then the two values must be EQUAL: an
// object has the same keys, a list the same entries in the same order, and a value Vitest resolves
// is the one the reader gives. Vitest's side alone is normalised, by what its `resolveConfig` is
// documented (in its source) to add:
// - a path made absolute, with the project's root written `<root>`;
// - `name` as its label; `reporters` and `coverage.reporter` as `[name, options]` pairs;
// - `coverage.include`: a name that is no glob becomes `name/**` (`resolveConfig.ts` L598-L607), a
//   rule applied to the reader's value before the two are compared;
// - `coverage.exclude`: Vitest appends the setup files, the test `include` patterns, the config's
//   path, the twelve config file names and three Vite-internal globs (L609-L631); that tail is
//   checked to be there and removed, so the rest must equal the config's own entries;
// - a key Vitest fills in that the reader has no entry for must equal what Vitest resolves for an
//   empty directory, or it is a difference ("missing on our side").
// A value that differs between two reads of the config by Vitest itself is handled in
// `unstableLeaves`, never by name.
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { encode, type KeyDifference } from '../jest-config/compare.ts'

/** Track 11 F4's 30 most-used Vitest `test.*` keys, in rank order. */
export const TEST_BAR_KEYS: readonly string[] = [
  'environment',
  'include',
  'setupFiles',
  'globals',
  'name',
  'exclude',
  'projects',
  'coverage',
  'testTimeout',
  'reporters',
  'pool',
  'typecheck',
  'dir',
  'browser',
  'root',
  'server',
  'globalSetup',
  'isolate',
  'watch',
  'env',
  'hookTimeout',
  'alias',
  'sequence',
  'maxWorkers',
  'clearMocks',
  'execArgv',
  'fileParallelism',
  'retry',
  'environmentOptions',
  'restoreMocks',
]

const PATH_KEYS: ReadonlySet<string> = new Set(['setupFiles', 'globalSetup', 'dir', 'root'])

type Rec = Record<string, unknown>

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An encoded function or RegExp is a value, not an object to look inside. */
function isMarker(value: Rec): boolean {
  return '$function' in value || '$regexp' in value
}

/** `encode`s a resolved `test` the way both sides of the comparison are encoded. */
export function encodeTest(test: unknown): Rec {
  return encode(test) as Rec
}

/** A path made absolute against `root`, with `root` itself written `<root>`. */
function normalizePath(entry: string, root: string, isModule: boolean): string {
  let absolute = entry
  if (!isAbsolute(entry)) {
    if (entry.startsWith('.') || !isModule) absolute = resolve(root, entry)
    else {
      try {
        absolute = createRequire(join(root, 'noop.js')).resolve(entry)
      } catch {
        // Vitest reads a name that is no package as a path from the root.
        absolute = resolve(root, entry)
      }
    }
  }
  if (absolute === root) return '<root>'
  return absolute.startsWith(`${root}/`) ? `<root>${absolute.slice(root.length)}` : absolute
}

/** A reporter as `[name, options]`, whichever way it was written. */
function reporterPair(entry: unknown): unknown {
  return Array.isArray(entry) ? [entry[0], entry[1] ?? {}] : [entry, {}]
}

function pairs(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(reporterPair)
}

/** Vitest's own name for a pattern with no glob characters: `src` is `src/**`. */
function globbed(entry: unknown): unknown {
  if (typeof entry !== 'string' || /[*?{}[\]()!+@]/.test(entry)) return entry
  return entry.endsWith('/') ? `${entry}**` : `${entry}/**`
}

/** What `resolveConfig` appends to `coverage.exclude`, from the values it resolved. */
function coverageExcludeTail(test: Rec, root: string, configFile: string | undefined): string[] {
  const list = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
      (entry): entry is string => typeof entry === 'string',
    )
  const coverage = isRec(test.coverage) ? test.coverage : {}
  const prefix = coverage.allowExternal === true ? '**/' : ''
  const names = ['vitest', 'vite'].flatMap((name) =>
    ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${name}.config.${ext}`),
  )
  return [
    ...list(test.setupFiles).map((file) => `${prefix}${relative(root, file)}`),
    ...list(test.include).filter((pattern) => !pattern.startsWith('!')),
    ...(configFile === undefined ? [] : [configFile]),
    ...names,
    '**/virtual:*',
    '**/__x00__*',
    '**/node_modules/**',
  ]
}

/** Both sides' `key`, normalised as the header says. `theirs` is Vitest's whole `test`. */
function normalizeValue(
  key: string,
  value: unknown,
  root: string,
  side: { readonly theirs?: Rec; readonly configFile?: string | undefined } = {},
): unknown {
  if (PATH_KEYS.has(key)) {
    const isModule = key === 'setupFiles' || key === 'globalSetup'
    // Vitest reads one path as a list of one.
    const list = isModule && typeof value === 'string' ? [value] : value
    if (typeof list === 'string') return normalizePath(list, root, false)
    if (Array.isArray(list)) {
      return list.map((entry) =>
        typeof entry === 'string' ? normalizePath(entry, root, isModule) : entry,
      )
    }
    return list
  }
  if (key === 'coverage' && isRec(value)) {
    const out: Rec = { ...value }
    if (value.reporter !== undefined) out.reporter = pairs(value.reporter)
    if (side.theirs !== undefined) {
      // Vitest's side: the appended tail is checked and removed.
      if (Array.isArray(value.exclude)) {
        const tail = coverageExcludeTail(side.theirs, root, side.configFile)
        const head = value.exclude.slice(0, value.exclude.length - tail.length)
        const rest = value.exclude.slice(head.length)
        out.exclude = JSON.stringify(rest) === JSON.stringify(tail) ? head : value.exclude
      }
    } else if (Array.isArray(value.include)) {
      // The reader's side: Vitest's documented `name` to `name/**`.
      out.include = value.include.map(globbed)
    }
    return out
  }
  if (key === 'name') {
    if (isRec(value) && typeof value.label === 'string') return value.label
    return value
  }
  if (key === 'reporters') return pairs(value)
  return value
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** A path into a value: `a.b[2].c`. */
function pathKey(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/**
 * The first place `ours` and `theirs` differ, or `null`. Objects must have the same keys, except
 * that a key only Vitest has must equal what Vitest resolves for an empty directory (`defaults`);
 * lists must be equal entry by entry; a function equals a function (the config's transform changes
 * its source); a plugin object is Vite's to fill in, so `plugins` is not looked into.
 */
export function firstDifference(
  ours: unknown,
  theirs: unknown,
  defaults: unknown,
  path = '',
): string | null {
  if (isRec(ours) && isRec(theirs)) {
    if (isMarker(ours) || isMarker(theirs)) {
      if ('$function' in ours && '$function' in theirs) return null
      return same(ours, theirs) ? null : path
    }
    const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)])
    for (const key of keys) {
      if (key === 'plugins') continue
      const here = pathKey(path, key)
      if (!(key in theirs)) {
        if (ours[key] !== undefined) return `${here} (only ours)`
        continue
      }
      if (!(key in ours)) {
        const fallback = isRec(defaults) ? defaults[key] : undefined
        if (!same(theirs[key], fallback)) return `${here} (missing on our side)`
        continue
      }
      const inner = firstDifference(
        ours[key],
        theirs[key],
        isRec(defaults) ? defaults[key] : undefined,
        here,
      )
      if (inner !== null) return inner
    }
    return null
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    if (ours.length !== theirs.length)
      return `${path} (length ${ours.length} against ${theirs.length})`
    for (let index = 0; index < ours.length; index++) {
      const inner = firstDifference(ours[index], theirs[index], undefined, `${path}[${index}]`)
      if (inner !== null) return inner
    }
    return null
  }
  return same(ours, theirs) ? null : path
}

/** A leaf where two reads of the config by Vitest itself gave different values. */
export interface UnstableLeaf {
  readonly path: string
  readonly first: unknown
  readonly second: unknown
}

/**
 * The leaves where two reads of one config by Vitest, in separate processes, differ: a random
 * seed, a path made from `process.pid`. Only leaves are found, in a structure the two reads
 * share; a list whose length differs between the reads is never masked (the comparison then says
 * what differs).
 */
export function unstableLeaves(first: unknown, second: unknown, path = ''): UnstableLeaf[] {
  if (isRec(first) && isRec(second) && !isMarker(first) && !isMarker(second)) {
    const keys = new Set([...Object.keys(first), ...Object.keys(second)])
    return [...keys].flatMap((key) => unstableLeaves(first[key], second[key], pathKey(path, key)))
  }
  if (Array.isArray(first) && Array.isArray(second) && first.length === second.length) {
    return first.flatMap((entry, index) =>
      unstableLeaves(entry, second[index], `${path}[${index}]`),
    )
  }
  return same(first, second) ? [] : [{ path, first, second }]
}

/** The leaf of `value` at `path` (`a.b[2]`), or `undefined`. */
function leafAt(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (Array.isArray(current)) current = current[Number(part)]
    else if (isRec(current)) current = current[part]
    else return undefined
  }
  return current
}

/** `value` with the leaf at each of `paths` replaced by a marker. */
function maskLeaves(value: unknown, paths: ReadonlySet<string>, path = ''): unknown {
  if (paths.has(path)) return '<unstable>'
  if (Array.isArray(value))
    return value.map((entry, index) => maskLeaves(entry, paths, `${path}[${index}]`))
  if (isRec(value) && !isMarker(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        maskLeaves(inner, paths, pathKey(path, key)),
      ]),
    )
  }
  return value
}

/**
 * Whether `value` is a value Vitest's two reads could both have given: a number for numbers, and
 * for strings the text the two share at both ends (`/tmp/vitest-<n>.localstorage`).
 */
export function matchesUnstable(value: unknown, first: unknown, second: unknown): boolean {
  if (typeof first === 'number' && typeof second === 'number') return typeof value === 'number'
  if (typeof first === 'string' && typeof second === 'string' && typeof value === 'string') {
    let start = 0
    while (start < first.length && start < second.length && first[start] === second[start]) start++
    let end = 0
    while (
      end < first.length - start &&
      end < second.length - start &&
      first[first.length - 1 - end] === second[second.length - 1 - end]
    ) {
      end++
    }
    return (
      value.length >= start + end &&
      value.startsWith(first.slice(0, start)) &&
      value.endsWith(first.slice(first.length - end))
    )
  }
  return false
}

/** An alias value (an object, or a list of `{ find, replacement }`) as `[find, replacement]` pairs. */
function aliasPairs(value: unknown): [unknown, unknown][] {
  const trim = (find: unknown, replacement: unknown): [unknown, unknown] =>
    typeof find === 'string' &&
    find.endsWith('/') &&
    typeof replacement === 'string' &&
    replacement.endsWith('/')
      ? [find.slice(0, -1), replacement.slice(0, -1)]
      : [find, replacement]
  if (Array.isArray(value)) {
    return value.filter(isRec).map((entry) => trim(entry.find, entry.replacement))
  }
  return isRec(value)
    ? Object.entries(value).map(([find, replacement]) => trim(find, replacement))
    : []
}

/** Keys Vitest derives from others (`fileParallelism: false` makes `maxWorkers` 1): never counted as set by value. */
const DERIVED_KEYS: ReadonlySet<string> = new Set(['maxWorkers'])

/** What a comparison of one config found. */
export interface TestComparison {
  /** The keys the config sets, and so were compared. */
  readonly compared: readonly string[]
  readonly differences: readonly KeyDifference[]
  /** Leaves Vitest derives itself that differ between its two reads: masked on both sides. */
  readonly masked: readonly string[]
  /** Leaves under a key the config sets that differ between Vitest's reads: ours must match. */
  readonly verified: readonly string[]
}

/** What the comparison needs to know about the read of one config. */
export interface CompareInputs {
  /** The reader's merged `test`. */
  readonly ours: Rec
  /** Vitest's resolved `test`, and the config path it resolved (for `coverage.exclude`). */
  readonly theirs: Rec
  readonly configFile?: string
  /** Vitest's resolved `test` from a second read in another process. */
  readonly again?: Rec
  readonly root: string
  /** What Vitest resolves for an empty directory, and that directory. */
  readonly defaults: Rec
  readonly defaultsRoot: string
  /** The keys the config and the command line name. */
  readonly given: ReadonlySet<string>
  /** Vitest's `resolve.alias`, where `test.alias` ends up. */
  readonly theirAlias?: unknown
}

/** Compares the reader's `test` with Vitest's. */
export function compareTest(inputs: CompareInputs): TestComparison {
  const { ours, theirs, again, root, defaults, defaultsRoot, given } = inputs
  const compared: string[] = []
  const differences: KeyDifference[] = []
  const masked: string[] = []
  const verified: string[] = []
  const side = { theirs, configFile: inputs.configFile }
  for (const key of TEST_BAR_KEYS) {
    const theirValue = normalizeValue(key, theirs[key], root, side)
    const defaultValue = normalizeValue(key, defaults[key], defaultsRoot, { theirs: defaults })
    // Set by the config: a key it names, or Vitest's plain value differs from its default. An
    // object value that differs may only be Vitest's own resolution, so it counts only when named.
    const isSet =
      given.has(key) ||
      (!DERIVED_KEYS.has(key) && !isRec(theirValue) && !same(theirValue, defaultValue))
    if (!isSet) continue
    compared.push(key)
    if (key === 'alias') {
      // Vitest folds test.alias into resolve.alias: every pair of ours must be in it.
      const there = aliasPairs(inputs.theirAlias)
      const missing = aliasPairs(ours.alias).filter(
        ([find, replacement]) => !there.some((pair) => same(pair, [find, replacement])),
      )
      if (missing.length > 0) differences.push({ key, ours: missing, theirs: there })
      continue
    }
    let ourValue = normalizeValue(key, ours[key], root)
    let theirNormal = theirValue
    // Leaves Vitest itself reads differently the second time.
    if (again !== undefined) {
      const second = normalizeValue(key, again[key], root, {
        theirs: again,
        configFile: inputs.configFile,
      })
      const hide = new Set<string>()
      for (const leaf of unstableLeaves({ [key]: theirNormal }, { [key]: second })) {
        hide.add(leaf.path)
        if (!given.has(key)) {
          // Vitest derives it (an unnamed project's name, a seed): masked on both sides.
          masked.push(leaf.path)
          continue
        }
        // The config sets this key: its value must be one Vitest could have given.
        const ours_ = leafAt({ [key]: ourValue }, leaf.path)
        if (matchesUnstable(ours_, leaf.first, leaf.second)) verified.push(leaf.path)
        else differences.push({ key: leaf.path, ours: ours_, theirs: leaf.first })
      }
      if (hide.size > 0) {
        ourValue = (maskLeaves({ [key]: ourValue }, hide) as Rec)[key]
        theirNormal = (maskLeaves({ [key]: theirNormal }, hide) as Rec)[key]
      }
    }
    const where = firstDifference(ourValue, theirNormal, defaultValue)
    if (where !== null)
      differences.push({
        key: where === '' ? key : `${key}${where.startsWith('[') ? '' : '.'}${where}`,
        ours: ourValue,
        theirs: theirNormal,
      })
  }
  return { compared, differences, masked, verified }
}
