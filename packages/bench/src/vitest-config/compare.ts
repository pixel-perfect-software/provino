// What the Vitest config sample compares (B25c, T11.15, D28's terms): the reader's `test` against
// `vitest/node`'s `resolveConfig(...).test`, on the 30 `test.*` keys Track 11 F4 ranks highest
// among Vitest repositories. Both sides are encoded the same way (`../jest-config/compare.ts`'s
// `encode`: functions as their source, `RegExp` as source and flags, `undefined` kept).
//
// A key is compared when the config sets it: when Vitest's resolved value differs from what Vitest
// resolves for an empty directory (`defaults`). Then the reader's merged `test` must give the same
// value, as an object is a subset of Vitest's (Vitest fills in nested defaults), after:
// - paths made absolute and the project's root written as `<root>` (Vitest resolves `setupFiles`,
//   `globalSetup`, `dir` and `root`; the reader keeps them as written until it makes the neutral
//   project),
// - `name` as its label, and `reporters` as `[name, options]` pairs.
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
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

/** A list entry that is an object to look inside (a project), not a value. */
function isObjectEntry(value: unknown): value is Rec {
  return isRec(value) && !isMarker(value)
}

/**
 * The paths (`projects[12].test.execArgv[3]`) where two reads of the same config by Vitest itself
 * differ: a value that depends on the process, such as a path made from `process.pid`. Such a
 * value can't be compared with anything, so the comparison masks it on both sides.
 */
export function unstablePaths(first: unknown, second: unknown, path = ''): string[] {
  if (isRec(first) && isRec(second)) {
    if (isMarker(first) || isMarker(second))
      return JSON.stringify(first) === JSON.stringify(second) ? [] : [path]
    const keys = new Set([...Object.keys(first), ...Object.keys(second)])
    return [...keys].flatMap((key) =>
      unstablePaths(first[key], second[key], path === '' ? key : `${path}.${key}`),
    )
  }
  if (Array.isArray(first) && Array.isArray(second)) {
    if (first.length !== second.length) return [path]
    return first.flatMap((entry, index) => unstablePaths(entry, second[index], `${path}[${index}]`))
  }
  return JSON.stringify(first) === JSON.stringify(second) ? [] : [path]
}

/** `value` with each of `paths` replaced by a marker. */
export function maskPaths(value: unknown, paths: ReadonlySet<string>, path = ''): unknown {
  if (paths.has(path)) return '<unstable>'
  if (Array.isArray(value))
    return value.map((entry, index) => maskPaths(entry, paths, `${path}[${index}]`))
  if (isRec(value) && !isMarker(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        maskPaths(inner, paths, path === '' ? key : `${path}.${key}`),
      ]),
    )
  }
  return value
}

/** `encode`d values are plain JSON; this is the one place the code looks inside them. */
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

function normalizeValue(key: string, value: unknown, root: string): unknown {
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
    // A reporter is a name or a [name, options] pair, and Vitest adds the ones it needs; it writes
    // a glob without its leading `./`.
    const bare = (list: unknown) =>
      Array.isArray(list)
        ? list.map((entry) => (typeof entry === 'string' ? entry.replace(/^\.\//, '') : entry))
        : list
    const reporter =
      value.reporter === undefined
        ? {}
        : {
            reporter: (Array.isArray(value.reporter) ? value.reporter : [value.reporter]).map(
              (entry) => (Array.isArray(entry) ? entry[0] : entry),
            ),
          }
    // Vitest 5 writes a plain path in `include` as `path/**`.
    const globbed = (list: unknown) =>
      Array.isArray(list)
        ? list.map((entry) =>
            typeof entry === 'string' && !/[*?{}[\]]/.test(entry) ? `${entry}/**` : entry,
          )
        : list
    const include = value.include === undefined ? {} : { include: globbed(bare(value.include)) }
    const exclude = value.exclude === undefined ? {} : { exclude: bare(value.exclude) }
    return { ...value, ...reporter, ...include, ...exclude }
  }
  if (key === 'name') {
    if (isRec(value) && typeof value.label === 'string') return value.label
    return value
  }
  if (key === 'reporters') {
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
    return list.map((entry) => (Array.isArray(entry) ? [entry[0], entry[1] ?? {}] : [entry, {}]))
  }
  return value
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Whether `ours` holds everything `theirs` holds. Objects go key by key; a list inside an object
 * must be contained (Vitest adds entries it resolves, such as the config file to `coverage.exclude`),
 * and every other value is equal.
 */
export function subsetOf(ours: unknown, theirs: unknown, nested = false): boolean {
  // A function is its source, which the config's transform changes (types stripped, imports
  // rewritten): two functions are equal here.
  if (isRec(ours) && isRec(theirs) && '$function' in ours && '$function' in theirs) return true
  if (isRec(ours) && isRec(theirs) && !isMarker(ours)) {
    // A plugin object is filled in by Vite (its `api`, its hooks' options): not compared.
    return Object.entries(ours).every(
      ([key, value]) => key === 'plugins' || subsetOf(value, theirs[key], true),
    )
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    // A list of objects (`projects`) goes entry by entry; a list of values nested in an object must
    // be contained, since Vitest adds the entries it resolves.
    if (ours.some(isObjectEntry)) {
      return (
        ours.length === theirs.length &&
        ours.every((entry, index) => subsetOf(entry, theirs[index], true))
      )
    }
    if (nested) return ours.every((entry) => theirs.some((other) => same(entry, other)))
  }
  return same(ours, theirs)
}

/** What a comparison of one config found. */
export interface TestComparison {
  /** The keys the config sets, and so were compared. */
  readonly compared: readonly string[]
  readonly differences: readonly KeyDifference[]
}

/**
 * Compares the reader's merged `test` (`ours`) with Vitest's resolved one (`theirs`), both
 * encoded, for a config in `root`. `defaults` is what Vitest resolves for an empty directory
 * `defaultsRoot`.
 */
/** Keys Vitest derives from others (`fileParallelism: false` makes `maxWorkers` 1): never counted as set by value. */
const DERIVED_KEYS: ReadonlySet<string> = new Set(['maxWorkers'])

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

export function compareTest(
  ours: Rec,
  theirs: Rec,
  root: string,
  defaults: Rec,
  defaultsRoot: string,
  given: ReadonlySet<string>,
  theirAlias: unknown = undefined,
  unstable: ReadonlySet<string> = new Set(),
): TestComparison {
  if (unstable.size > 0) {
    ours = maskPaths(ours, unstable) as Rec
    theirs = maskPaths(theirs, unstable) as Rec
  }
  const compared: string[] = []
  const differences: KeyDifference[] = []
  for (const key of TEST_BAR_KEYS) {
    const theirValue = normalizeValue(key, theirs[key], root)
    const defaultValue = normalizeValue(key, defaults[key], defaultsRoot)
    // Set by the config: a key it names, or a plain value that is not Vitest's default. An object
    // or list value that differs from the default may only be Vitest's own resolution (a random
    // seed, absolute paths added), so it counts only when the config names the key.
    const isSet =
      given.has(key) ||
      (!DERIVED_KEYS.has(key) && !isRec(theirValue) && !same(theirValue, defaultValue))
    if (!isSet) continue
    compared.push(key)
    if (key === 'alias') {
      // Vitest folds test.alias into resolve.alias: every pair of ours must be in it.
      const pairs = aliasPairs(theirAlias)
      const missing = aliasPairs(ours.alias).filter(
        ([find, replacement]) => !pairs.some((pair) => same(pair, [find, replacement])),
      )
      if (missing.length > 0) differences.push({ key, ours: missing, theirs: pairs })
      continue
    }
    const ourValue = normalizeValue(key, ours[key], root)
    const equal = subsetOf(ourValue, theirValue)
    if (!equal) differences.push({ key, ours: ourValue, theirs: theirValue })
  }
  return { compared, differences }
}
