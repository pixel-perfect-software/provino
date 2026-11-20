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
// Nothing is masked. What Vitest derives from the clock or the process (the shuffle seed, a path
// made from the process id) is pinned at its source in `oracle.ts` (`Date.now` stubbed, the
// process id written `<pid>`).
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

/** Where Vitest puts the html report when the config names no `htmlDir`. */
function inferredHtmlDir(coverage: Rec, root: string): string | undefined {
  const directory = resolve(
    root,
    typeof coverage.reportsDirectory === 'string' ? coverage.reportsDirectory : './coverage',
  )
  const reporters = pairs(coverage.reporter) as [unknown, unknown][]
  const html = reporters.find(([name]) => name === 'html' || name === 'html-spa')
  if (html !== undefined) {
    const options = html[1]
    const subdir = isRec(options) && typeof options.subdir === 'string' ? options.subdir : '.'
    return resolve(directory, subdir || '.')
  }
  return reporters.some(([name]) => name === 'lcov') ? resolve(directory, 'lcov-report') : undefined
}

/** One resolved project, as Vitest's `createVitest` holds it. */
export interface OracleProject {
  readonly name: string
  readonly root: string
  readonly include: readonly string[]
  readonly setupFiles: readonly string[]
  /** The project's resolved config file, if it has one. */
  readonly config?: string | undefined
  readonly allowExternal: boolean
}

/**
 * Vitest's `coverage.exclude` is the config's own list followed by what each resolution of a
 * project appends to the one coverage object they share: the root's block, then (when there are
 * `test.projects`) one block per project, each as `coverageExcludeTail` builds it (L609-L631).
 * The projects resolve concurrently, so the blocks come in the order they finished; the list must
 * be the reader's entries first, then exactly those blocks, each whole, in any order.
 */
function matchesExclude(
  actual: readonly unknown[],
  ours: readonly unknown[],
  test: Rec,
  root: string,
  configFile: string | undefined,
  projects: readonly OracleProject[] | null | undefined,
): boolean {
  if (actual.length < ours.length || !ours.every((entry, index) => same(entry, actual[index]))) {
    return false
  }
  const wanted = [coverageExcludeTail(test, root, configFile)]
  if (Array.isArray(test.projects) && test.projects.length > 0 && projects != null) {
    for (const project of projects) {
      wanted.push(
        coverageExcludeTail(
          {
            setupFiles: project.setupFiles,
            include: project.include,
            coverage: { allowExternal: project.allowExternal },
          },
          project.root,
          project.config,
        ),
      )
    }
  }
  // Each block ends with the last of Vitest's own entries.
  const blocks: unknown[][] = []
  let block: unknown[] = []
  for (const entry of actual.slice(ours.length)) {
    block.push(entry)
    if (entry === '**/node_modules/**') {
      blocks.push(block)
      block = []
    }
  }
  if (block.length > 0) return false
  const key = (list: readonly unknown[][]): string[] =>
    list.map((item) => JSON.stringify(item)).sort()
  return same(key(blocks), key(wanted))
}

/** Both sides' `key`, normalised as the header says. `theirs` is Vitest's whole `test`. */
function normalizeValue(
  key: string,
  value: unknown,
  root: string,
  side: {
    readonly theirs?: Rec
    readonly ours?: Rec
    readonly configFile?: string | undefined
    readonly projects?: readonly OracleProject[] | null | undefined
  } = {},
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
      // Vitest's side: what it appends is checked and removed.
      const ours = isRec(side.ours?.coverage) ? side.ours.coverage : undefined
      if (Array.isArray(value.exclude) && Array.isArray(ours?.exclude)) {
        const wanted = matchesExclude(
          value.exclude,
          ours.exclude,
          side.theirs,
          root,
          side.configFile,
          side.projects,
        )
        if (wanted) out.exclude = ours.exclude
      }
      // The directory of the html report is inferred when the config names none (L527-L553).
      if (typeof value.htmlDir === 'string' && ours?.htmlDir === undefined) {
        if (value.htmlDir === inferredHtmlDir(value, root)) delete out.htmlDir
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
        // A leaf masked because Vitest derives it (a seed) and the config doesn't name it.
        if (theirs[key] === '<unstable>') continue
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

/** Keys Vitest derives from others (`fileParallelism: false` makes `maxWorkers` 1): never counted as set by value. */
const DERIVED_KEYS: ReadonlySet<string> = new Set(['maxWorkers'])

/** What a comparison of one config found. */
export interface TestComparison {
  /** The keys the config sets, and so were compared. */
  readonly compared: readonly string[]
  readonly differences: readonly KeyDifference[]
  /** Keys the config sets that could not be compared, and why. */
  readonly skipped: readonly string[]
}

/** What the comparison needs to know about the read of one config. */
export interface CompareInputs {
  /** The reader's merged `test`. */
  readonly ours: Rec
  /** Vitest's resolved `test`, and the config path it resolved (for `coverage.exclude`). */
  readonly theirs: Rec
  readonly configFile?: string
  readonly root: string
  /** What Vitest resolves for an empty directory, and that directory. */
  readonly defaults: Rec
  readonly defaultsRoot: string
  /** The keys the config and the command line name. */
  readonly given: ReadonlySet<string>
  /** Vitest's `resolve.alias` for the config, and for the empty directory. */
  readonly theirAlias?: unknown
  readonly defaultAlias?: unknown
  /** The reader's `mergeAlias(resolve.alias, test.alias)`, normalised, encoded. */
  readonly ourAlias?: unknown
  /** The resolved projects of each side: `null` when Vitest's could not be read. */
  readonly ourProjects?: readonly { readonly name: string; readonly root: string }[]
  readonly theirProjects?: readonly OracleProject[] | null
}

/** An alias entry as `{ find, replacement }`, nothing else. */
function aliasEntries(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : []).map((entry) =>
    isRec(entry) ? { find: entry.find, replacement: entry.replacement } : entry,
  )
}

/** Compares the reader's `test` with Vitest's. */
export function compareTest(inputs: CompareInputs): TestComparison {
  const { ours, theirs, root, defaults, defaultsRoot, given } = inputs
  const compared: string[] = []
  const differences: KeyDifference[] = []
  const skipped: string[] = []
  const side = { theirs, ours, configFile: inputs.configFile, projects: inputs.theirProjects }
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
      // Vitest folds test.alias into resolve.alias after its own entries: what it has beyond the
      // empty directory's entries is the reader's list, in order.
      const defaultEntries = aliasEntries(inputs.defaultAlias)
      const there = aliasEntries(inputs.theirAlias).filter(
        (entry) => !defaultEntries.some((known) => same(known, entry)),
      )
      const here = aliasEntries(inputs.ourAlias)
      if (!same(here, there)) differences.push({ key, ours: here, theirs: there })
      continue
    }
    if (key === 'projects') {
      if (inputs.theirProjects == null) {
        skipped.push('projects (Vitest could not list its projects)')
        continue
      }
      // Vitest lists the projects its glob finds in the order the file system gives them (and
      // resolves them concurrently), so both lists are put in the order of name and root.
      const nameAndRoot = (list: readonly { name: string; root: string }[]) =>
        list
          .map((project) => ({
            name: project.name,
            root: normalizePath(project.root, root, false),
          }))
          .sort((a, b) => (a.name + a.root < b.name + b.root ? -1 : 1))
      const here = nameAndRoot(inputs.ourProjects ?? [])
      const there = nameAndRoot(inputs.theirProjects)
      if (!same(here, there)) differences.push({ key, ours: here, theirs: there })
      continue
    }
    const ourValue = normalizeValue(key, ours[key], root)
    const where = firstDifference(ourValue, theirValue, defaultValue)
    if (where !== null)
      differences.push({
        key: where === '' ? key : `${key}${where.startsWith('[') ? '' : '.'}${where}`,
        ours: ourValue,
        theirs: theirValue,
      })
  }
  return { compared, differences, skipped }
}
