// `provino jest` with no Jest config at the root (an improvement over Jest, which says nothing;
// DIVERGENCES): when directories below the root hold test files and have a Jest config of their
// own, one line on stderr before the run says so and names `--projects`. Jest runs a root with no
// config over its defaults, so a monorepo root finds every package's tests and runs each with the
// defaults, which fails them in ways that look like Provino's; the line points at the way out.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { JEST_CONFIG_CANDIDATES } from '@provino/dialect-jest/node'
import type { FileInfo, Reporter, RunInfo } from '@provino/types'

/** The directories named in the line before it says "…". */
const LISTED = 5

/** The config file names of a directory, `package.json` (whose `jest` key counts) apart. */
const CONFIG_FILES: ReadonlySet<string> = new Set(
  JEST_CONFIG_CANDIDATES.filter((name) => name !== 'package.json'),
)

/** Whether `package.json` in `directory` has a `jest` key (an unreadable file has none). */
function hasJestKey(directory: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && Boolean(Reflect.get(parsed, 'jest'))
  } catch {
    return false
  }
}

/**
 * Whether a package.json found for the run holds no Jest config of its own: Jest's finder stops at
 * the first package.json it meets, with a `jest` key or not, and reads `{}` from one without.
 * @internal
 */
export function packageJsonHasNoJestKey(path: string): boolean {
  return !hasJestKey(dirname(path))
}

/**
 * The directories below `rootDir` that hold some of `files` and have a Jest config (a
 * `jest.config.*`, or a `jest` key in `package.json`), each the nearest one above a file, as
 * POSIX paths from `cwd`, sorted. A directory is looked at once however many files lie under it
 * or below it (one `readdir`, and a `package.json` read only when there is one), and only those
 * directories and their parents up to the root are looked at: nothing is walked.
 * @internal
 */
export function projectsBelow(
  rootDir: string,
  files: readonly string[],
  cwd: string = rootDir,
): readonly string[] {
  const nearest = new Map<string, string | null>()
  const configIn = (directory: string): boolean => {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return false
    }
    return (
      names.some((name) => CONFIG_FILES.has(name)) ||
      (names.includes('package.json') && hasJestKey(directory))
    )
  }
  const nearestAbove = (directory: string): string | null => {
    if (directory === rootDir || !directory.startsWith(`${rootDir}${sep}`)) return null
    const known = nearest.get(directory)
    if (known !== undefined) return known
    const found = configIn(directory) ? directory : nearestAbove(dirname(directory))
    nearest.set(directory, found)
    return found
  }
  const found = new Set<string>()
  for (const file of files) {
    const directory = nearestAbove(dirname(file))
    if (directory !== null) found.add(directory)
  }
  return [...found].map((directory) => relative(cwd, directory).split(sep).join('/')).toSorted()
}

/**
 * The line, or `undefined` when no directory below has a config. At most `LISTED` directories are
 * named, then "…".
 * @internal
 */
export function noRootConfigHint(directories: readonly string[]): string | undefined {
  if (directories.length === 0) return undefined
  const count = directories.length
  const named = directories.slice(0, LISTED).join(', ')
  const listed = count > LISTED ? `${named}, …` : named
  return (
    `provino: no Jest config here; ${count} ${count === 1 ? 'directory' : 'directories'} below ` +
    `${count === 1 ? 'has' : 'have'} one (${listed}). Run with --projects <dirs> to use them.`
  )
}

/**
 * A reporter that writes the line when the run starts, from the files the run found (the
 * coordinator's discovery: nothing is searched for here). Only for a run whose config was not
 * found and whose stdout carries no machine output; the caller decides that.
 * @internal
 */
export function noRootConfigHintReporter(options: {
  readonly rootDir: string
  readonly cwd: string
  readonly write: (text: string) => void
}): Reporter {
  return {
    name: 'no-root-config-hint',
    'run:start': (_info: RunInfo, files: readonly FileInfo[]) => {
      const hint = noRootConfigHint(
        projectsBelow(
          options.rootDir,
          files.map((file) => join(options.rootDir, file.path)),
          options.cwd,
        ),
      )
      if (hint !== undefined) options.write(`${hint}\n`)
    },
  }
}
