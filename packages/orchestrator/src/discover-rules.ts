// U2, the full form (B14c): test-file discovery by a dialect reader's rules (`NeutralDiscovery`),
// as Jest does it: a crawl of `roots` (what jest-haste-map's native `find` crawler gives), then the
// `testMatch` globs (picomatch, ordered negation: jest-util's `globsToMatcher`) or `testRegex`
// regular expressions on the path, then `testPathIgnorePatterns` (jest-core `SearchSource`). The
// neutral policy key `globMatchesOn` says which form of the path a glob sees. Checked against real
// Jest's `--listTests` on `fixtures/discovery/*`.
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import type { NeutralDiscovery, OrchestratorPolicy } from '@provino/types'
import picomatch from 'picomatch'
import type { DiscoveredFile } from './discover.ts'
import { OrchestratorError } from './errors.ts'
import { relativePosix } from './file-id.ts'
import { BATCH, byText, mapInBatches } from './util.ts'

/** Which form of a file's path a test glob is matched against (`orchestrator.globMatchesOn`). */
export type GlobMatchesOn = OrchestratorPolicy['globMatchesOn']

/**
 * The rules to apply.
 * @public
 */
export interface RuleDiscoverOptions {
  /** The project root: relative paths and `globMatchesOn: 'root-relative-path'` start here. */
  readonly rootDir: string
  readonly discovery: NeutralDiscovery
  readonly globMatchesOn: GlobMatchesOn
}

/** jest-haste-map always ignores these (`VCS_DIRECTORIES`), and files under `node_modules` unless it retains all. */
const ALWAYS_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.sl',
])
const NODE_MODULES = `${sep}node_modules${sep}`
const VCS_PATH = [`${sep}.git${sep}`, `${sep}.hg${sep}`, `${sep}.sl${sep}`]

/** How many directories are read at once. */
const CONCURRENCY = 64

/** `new RegExp` of the sources joined by `|`, as Jest builds its ignore patterns; none: undefined. */
function alternation(sources: readonly string[], what: string): RegExp | undefined {
  if (sources.length === 0) return undefined
  try {
    return new RegExp(sources.join('|'))
  } catch (cause) {
    throw new OrchestratorError(
      'ORCH_BAD_PATTERN',
      `${what} ${JSON.stringify(sources)} is not a valid regular expression`,
      { cause },
    )
  }
}

/** jest-util `replacePathSepForGlob` (a no-op on POSIX paths without a backslash). */
function replacePathSepForGlob(path: string): string {
  return path.replaceAll(/\\(?![$()+.?^{}])/g, '/')
}

/**
 * jest-util `globsToMatcher` with `dot: true`: every glob that matches keeps the path, every
 * negated glob that does not match drops it, the last verdict wins; with only negated globs a path
 * is kept unless dropped.
 */
function globsToMatcher(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false
  const matchers = globs.map((glob) => {
    let isMatch: ReturnType<typeof picomatch<true>>
    try {
      isMatch = picomatch(glob, { dot: true }, true)
    } catch (cause) {
      throw new OrchestratorError('ORCH_BAD_PATTERN', `the test glob "${glob}" is not valid`, {
        cause,
      })
    }
    const state: { negated?: boolean | undefined; negatedExtglob?: boolean | undefined } =
      isMatch.state
    return { isMatch, negated: state.negated === true || state.negatedExtglob === true }
  })
  const onlyNegated = matchers.every(({ negated }) => negated)
  return (path) => {
    const replaced = replacePathSepForGlob(path)
    let kept: boolean | undefined
    for (const { isMatch, negated } of matchers) {
      const matched = isMatch(replaced)
      if (!matched && negated) kept = false
      else if (matched && !negated) kept = true
    }
    return onlyNegated ? kept !== false : kept === true
  }
}

/** The sources as regular expressions: a path matches when any of them does. */
function regexMatcher(sources: readonly string[]): (path: string) => boolean {
  const regexes = sources.map((source) => {
    try {
      return new RegExp(source)
    } catch (cause) {
      throw new OrchestratorError(
        'ORCH_BAD_PATTERN',
        `the test regular expression ${JSON.stringify(source)} is not valid`,
        { cause },
      )
    }
  })
  return (path) => regexes.some((regex) => regex.test(path))
}

/**
 * The test-file predicate of a project's rules, on an absolute path: roots are the crawl's, so
 * this is `testMatch` or `testRegex`, and not matching `excludePatterns`. The crawl applies it to
 * every file it keeps.
 * @public
 */
export function testFilePredicate(options: RuleDiscoverOptions): (absolutePath: string) => boolean {
  const { rootDir, discovery, globMatchesOn } = options
  const { includePatterns } = discovery
  const matches =
    includePatterns.kind === 'regex'
      ? regexMatcher(includePatterns.patterns)
      : (() => {
          const glob = globsToMatcher(includePatterns.patterns)
          return globMatchesOn === 'absolute-path'
            ? glob
            : (path: string) => glob(relativePosix(rootDir, path))
        })()
  const ignored = alternation(discovery.excludePatterns, 'testPathIgnorePatterns')
  return (path) => matches(path) && !(ignored?.test(path) ?? false)
}

/** Every file under `root` that the crawl keeps: no symlinks, no ignored path, a listed extension. */
async function crawlRoot(
  root: string,
  extensions: ReadonlySet<string>,
  crawlIgnore: RegExp | undefined,
  found: Set<string>,
): Promise<void> {
  const pending: string[] = [root]
  let active = 0
  await new Promise<void>((done, fail) => {
    const pump = (): void => {
      while (active < CONCURRENCY && pending.length > 0) {
        const directory = pending.pop() as string
        active++
        readdir(directory, { withFileTypes: true }).then(
          (entries) => {
            for (const entry of entries) {
              // Jest's crawler (`enableSymlinks: false`) neither lists a link nor enters one.
              if (entry.isSymbolicLink()) continue
              const path = join(directory, entry.name)
              if (entry.isDirectory()) {
                if (!ALWAYS_IGNORED_DIRECTORIES.has(entry.name)) pending.push(path)
              } else if (entry.isFile()) {
                const dot = entry.name.lastIndexOf('.')
                // `find -iname '*.ext'`: the extension compares without regard to case.
                if (dot < 0 || !extensions.has(entry.name.slice(dot + 1).toLowerCase())) continue
                if (path.includes(NODE_MODULES) || VCS_PATH.some((vcs) => path.includes(vcs))) {
                  continue
                }
                if (crawlIgnore?.test(path) === true) continue
                found.add(path)
              }
            }
            active--
            if (active === 0 && pending.length === 0) done()
            else pump()
          },
          (error: NodeJS.ErrnoException) => {
            // An unreadable directory is skipped, as the crawler's `suppressErrors` does; a root
            // that does not exist finds nothing.
            active--
            if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR') {
              if (active === 0 && pending.length === 0) done()
              else pump()
              return
            }
            fail(error)
          },
        )
      }
      if (active === 0 && pending.length === 0) done()
    }
    pump()
  })
}

/**
 * Finds a project's test files by a dialect reader's rules. The result is sorted by relative path;
 * a file that vanishes between the crawl and its `stat` is left out.
 * @public
 */
export async function discoverByRules(
  options: RuleDiscoverOptions,
): Promise<readonly DiscoveredFile[]> {
  const { rootDir, discovery } = options
  const extensions = new Set(discovery.extensions.map((extension) => extension.toLowerCase()))
  const crawlIgnore = alternation(discovery.crawlIgnorePatterns, 'modulePathIgnorePatterns')
  const isTestFile = testFilePredicate(options)
  const found = new Set<string>()
  await Promise.all(
    discovery.roots.map((root) => crawlRoot(resolve(root), extensions, crawlIgnore, found)),
  )
  const matching = [...found].filter((path) => isTestFile(path))
  return (await sized(matching, rootDir)).sort((a, b) => byText(a.relativePath, b.relativePath))
}

/** Each path as a `DiscoveredFile`; one that is gone, or not a file, is left out. */
async function sized(paths: readonly string[], rootDir: string): Promise<DiscoveredFile[]> {
  const sizes = await mapInBatches(paths, BATCH, (path) =>
    stat(path).then(
      (info) => (info.isFile() ? info.size : undefined),
      () => undefined,
    ),
  )
  return paths.flatMap((path, index) => {
    const sizeBytes = sizes[index]
    return sizeBytes === undefined
      ? []
      : [{ path, relativePath: relativePosix(rootDir, path), sizeBytes }]
  })
}

/**
 * What `crawlProject` finds: every file the haste crawl keeps, and which of them are test files.
 * @public
 */
export interface ProjectCrawl {
  /** Absolute paths, sorted: every file under the roots with a listed extension, or `snap`. */
  readonly files: readonly string[]
  /** Whether a crawled file is one of the project's test files. */
  readonly isTest: (absolutePath: string) => boolean
}

/** What a crawl leaves out beyond the project's own `crawlIgnorePatterns`. */
export interface CrawlOptions {
  /** Regular expression sources: the project's `watchPathIgnorePatterns` (watch mode). */
  readonly ignorePatterns?: readonly string[]
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One walk of a project's roots for the affected-test graph (B23c, T9.12): every file whose
 * extension is one of the project's module file extensions, or `snap`, with jest-haste-map's rules
 * (no symlinks, nothing under `node_modules` or a VCS directory), leaving out what
 * `crawlIgnorePatterns` (`modulePathIgnorePatterns`) and `options.ignorePatterns` match and a
 * cache directory under the root (`createHasteMap` L333-342). The test files are the crawl
 * filtered by the project's rules, or by its `include` and `exclude` globs when it has none.
 * @public
 */
export async function crawlProject(
  project: Pick<ResolvedProject, 'rootDir' | 'discovery' | 'include' | 'exclude' | 'policy'> & {
    readonly cacheDirectory?: string | undefined
    readonly config: { readonly loader: { readonly extensions: readonly string[] } }
  },
  options: CrawlOptions = {},
): Promise<ProjectCrawl> {
  const { rootDir, discovery } = project
  const extensions = new Set(
    (discovery?.extensions ?? project.config.loader.extensions.map((e) => e.replace(/^\./, '')))
      .map((extension) => extension.toLowerCase())
      .concat('snap'),
  )
  const sources = [...(discovery?.crawlIgnorePatterns ?? []), ...(options.ignorePatterns ?? [])]
  const cache = project.cacheDirectory
  if (cache !== undefined && resolve(cache).startsWith(resolve(rootDir) + sep)) {
    sources.push(escapeRegExp(resolve(cache)))
  }
  const crawlIgnore = alternation(sources, 'modulePathIgnorePatterns')
  const found = new Set<string>()
  const roots = discovery?.roots ?? [rootDir]
  await Promise.all(roots.map((root) => crawlRoot(resolve(root), extensions, crawlIgnore, found)))
  const files = [...found].sort(byText)
  if (discovery !== null) {
    return {
      files,
      isTest: testFilePredicate({
        rootDir,
        discovery,
        globMatchesOn: project.policy.orchestrator.globMatchesOn,
      }),
    }
  }
  const included = globsToMatcher(project.include)
  const excluded = globsToMatcher(project.exclude)
  return {
    files,
    isTest: (path) => {
      const relative = relativePosix(rootDir, path)
      return included(relative) && !excluded(relative)
    },
  }
}
