// Which files a worker counts (T8.8): the order of jest-transform's `shouldInstrument`, as data in a
// `SerializedCoverageConfig`. A file the tests never load is never asked about; the files that
// don't pass are left uninstrumented (Istanbul) or out of the V8 take.
import { relative, sep } from 'node:path'
import type { SerializedCoverageConfig } from '@provino/types'
import picomatch from 'picomatch'
import { CoverageError } from './errors.ts'

type Matcher = (path: string) => boolean

/** The path with `/` separators, which is what a glob sees. */
function posix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * A list of globs as one matcher, with picomatch's `dot: true` and ordered negation: a path
 * matches when a positive glob keeps it and no negated one drops it, and a list of only negated
 * globs keeps what none of them drops (`globsToMatcher` of `jest-util`).
 */
function globsToMatcher(globs: readonly string[]): Matcher {
  if (globs.length === 0) return () => false
  const matchers = globs.map((glob) => {
    let isMatch: ReturnType<typeof picomatch<true>>
    try {
      isMatch = picomatch(glob, { dot: true }, true)
    } catch (cause) {
      throw new CoverageError('COVERAGE_BAD_CONFIG', `the coverage glob "${glob}" is not valid`, {
        cause,
      })
    }
    const state: { negated?: boolean | undefined; negatedExtglob?: boolean | undefined } =
      isMatch.state
    return { isMatch, negated: state.negated === true || state.negatedExtglob === true }
  })
  const onlyNegated = matchers.every(({ negated }) => negated)
  return (path) => {
    const replaced = posix(path)
    let kept: boolean | undefined
    for (const { isMatch, negated } of matchers) {
      const matched = isMatch(replaced)
      if (!matched && negated) kept = false
      else if (matched && !negated) kept = true
    }
    return onlyNegated ? kept !== false : kept === true
  }
}

function regexOf(source: string): RegExp {
  try {
    return new RegExp(source)
  } catch (cause) {
    throw new CoverageError(
      'COVERAGE_BAD_CONFIG',
      `the coverage pattern ${JSON.stringify(source)} is not a regular expression`,
      { cause },
    )
  }
}

/** A `node_modules` segment of a path. */
const NODE_MODULES = /(?:^|[\\/])node_modules[\\/]/

/** Matches a `__mocks__` directory in a path. */
const MOCKS = /[\\/]__mocks__[\\/]/

/**
 * The filter of one project's coverage config: whether the module at an absolute path counts.
 * The order is `shouldInstrument`'s: a forced file counts; a test file (unless a test-ignore
 * pattern matches it) does not; with include globs the path must match one (relative to the global root under
 * `includeRoot`); then the excluded patterns and paths, `__mocks__` and JSON files. With no
 * include globs every file the tests load counts, and only such a file is ever asked about. Last,
 * with the Istanbul provider as `babel-plugin-istanbul` does, a file outside the project root or under `node_modules` never counts; with V8, a file whose path does not start with the global root never does.
 * @public
 */
export function createCoverageFilter(config: SerializedCoverageConfig): (path: string) => boolean {
  const force = globsToMatcher(config.force)
  const testGlobs = globsToMatcher(config.testFiles)
  const testRegex = config.testRegex.map(regexOf)
  const testIgnore = config.testIgnorePatterns.map(regexOf)
  const include = globsToMatcher(config.include)
  const exclude = config.excludePatterns.map(regexOf)
  const excludedPaths = new Set(config.excludePaths)
  const counted = (path: string): boolean => {
    if (config.force.length > 0 && force(path)) return true
    if (!testIgnore.some((pattern) => pattern.test(path))) {
      if (testRegex.some((pattern) => pattern.test(path))) return false
      if (testGlobs(path)) return false
    }
    if (
      config.include.length > 0 &&
      !include(config.includeRoot ? posix(relative(config.globalRoot, path)) : path)
    ) {
      return false
    }
    if (exclude.some((pattern) => pattern.test(path))) return false
    if (excludedPaths.has(path)) return false
    if (MOCKS.test(path)) return false
    return !path.endsWith('.json')
  }
  if (config.provider !== 'istanbul') {
    // `V8CoverageCollector.getResult` keeps a script whose path starts with the global root (a raw
    // prefix, no separator added) before it asks `shouldInstrument`. A linked package outside the
    // root is out; there is no `node_modules` step for V8.
    return (path) => path.startsWith(config.globalRoot) && counted(path)
  }
  // babel-plugin-istanbul runs after `shouldInstrument` with `cwd` the project's root and
  // `excludeNodeModules` (test-exclude): a file outside the project root or under node_modules is
  // left uninstrumented even when `shouldInstrument` passed it, a forced file too.
  const rootPrefix = config.projectRoot.endsWith(sep)
    ? config.projectRoot
    : `${config.projectRoot}${sep}`
  return (path) =>
    path.startsWith(rootPrefix) &&
    !NODE_MODULES.test(relative(config.projectRoot, path)) &&
    counted(path)
}
