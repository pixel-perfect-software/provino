// B25c: the two glob jobs the reader has, both Vitest 5.0.5's own libraries (tinyglobby and
// picomatch, with `dot: true`; D-decision: compat and speed): a `test.projects` entry that names
// directories or config files, found as `resolveProjects.ts` finds them, and a `test.exclude` glob
// turned into the regular expression `NeutralDiscovery.excludePatterns` holds.
import { resolve, sep } from 'node:path'
import picomatch from 'picomatch'
import { glob } from 'tinyglobby'

/** Whether `text` has a glob character. */
export function isGlob(text: string): boolean {
  return /[*?{}[\]!]/.test(text)
}

/** `root` with the characters a glob would read as syntax escaped, as a literal prefix. */
function literalRoot(root: string): string {
  return root
    .split(sep)
    .join('/')
    .replace(/[\\*?[\]{}()!+@]/g, '\\$&')
}

/** A root-relative glob as the regular expression of the absolute paths it names under `root`. */
function rootedRegex(glob: string, root: string): RegExp {
  return picomatch.makeRe(`${literalRoot(root)}/${glob.replace(/^\.\//, '')}`, { dot: true })
}

/**
 * A root-relative glob (`**\/node_modules/**`) as the source of a regular expression that matches
 * the absolute path of a file it names under `root`, as `NeutralDiscovery.excludePatterns` wants.
 * @public
 */
export function globToRegexSource(glob: string, root: string): string {
  return rootedRegex(glob, root).source
}

/** Whether a negated project pattern (`!glob`) names `path`. */
export function isNegated(path: string, negations: readonly string[], root: string): boolean {
  return negations.some((negation) => rootedRegex(negation.slice(1), root).test(path))
}

/**
 * The paths under `root` that `patterns` name, sorted, as Vitest's `test.projects` globs find
 * them: tinyglobby with `dot: true`, directories included, and its ignore list (`node_modules`, a
 * bundled config's `*.timestamp-*`, macOS's `.DS_Store`). A pattern that starts with `!` removes
 * what it matches from the others.
 * @public
 */
export async function expandGlobs(root: string, patterns: readonly string[]): Promise<string[]> {
  const found = await glob([...patterns], {
    absolute: true,
    dot: true,
    onlyFiles: false,
    cwd: resolve(root),
    expandDirectories: false,
    ignore: ['**/node_modules/**', '**/*.timestamp-*', '**/.DS_Store'],
  })
  return found.map((path) => path.replace(/\/$/, '')).sort()
}
