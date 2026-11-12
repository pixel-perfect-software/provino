// D68: whether a Jest project has a Babel config, so its implicit `babel-jest` does more than hoist.
// babel-jest runs `loadPartialConfigSync` with `cwd` and `root` set to the project's `rootDir`
// (`babel-jest` `index.ts`, `mergeBabelTransformOptions`), so Babel's root mode "root" looks for
// `babel.config.*` in that directory only, and a file-relative config (`.babelrc*`, a `babel` key in
// `package.json`) applies to the files of the root's own package (`babelrcRoots` defaults to the
// root). The check is made once per project, by name, with no `@babel/core`.
import { type Dirent, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { packageJsonKey } from './find.ts'

/** Babel's root config file names (`@babel/core` `config/files/configuration.ts`). */
const ROOT_CONFIGS: readonly string[] = [
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.json',
  'babel.config.cts',
  'babel.config.ts',
]

/** Babel's file-relative config file names. */
const RELATIVE_CONFIGS: readonly string[] = [
  '.babelrc',
  '.babelrc.js',
  '.babelrc.cjs',
  '.babelrc.mjs',
  '.babelrc.json',
  '.babelrc.cts',
]

/** Directories the walk below the root never enters: dependencies, and git's own. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git'])

/**
 * Whether a `.babelrc*` sits below `dir` in the root's own package. Babel applies a file-relative
 * config found walking up from the file to its nearest `package.json`, when that package is in
 * `babelrcRoots` (default: the root), so a directory with a `package.json` of its own is another
 * package and is not entered.
 */
function hasRelativeConfigBelow(dir: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  const subdirectories: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) subdirectories.push(entry.name)
    } else if (RELATIVE_CONFIGS.includes(entry.name)) {
      return true
    }
  }
  for (const name of subdirectories) {
    const child = join(dir, name)
    if (existsSync(join(child, 'package.json'))) continue
    if (hasRelativeConfigBelow(child)) return true
  }
  return false
}

/**
 * Whether `rootDir` has a Babel config that babel-jest would load: a `babel.config.*` or a
 * `.babelrc*` there, a `babel` key in its `package.json`, or, when the root is a package (it has a
 * `package.json`), a `.babelrc*` anywhere below it that no other package owns.
 * @internal
 */
export function hasBabelConfig(rootDir: string): boolean {
  for (const name of ROOT_CONFIGS) if (existsSync(join(rootDir, name))) return true
  for (const name of RELATIVE_CONFIGS) if (existsSync(join(rootDir, name))) return true
  const packageJson = join(rootDir, 'package.json')
  if (packageJsonKey(packageJson, 'babel') != null) return true
  return existsSync(packageJson) && hasRelativeConfigBelow(rootDir)
}
