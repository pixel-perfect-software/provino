// D68: whether a Jest project has a Babel config, so its implicit `babel-jest` does more than hoist.
// babel-jest runs `loadPartialConfigSync` with `cwd` and `root` set to the project's `rootDir`
// (`babel-jest` `index.ts`, `mergeBabelTransformOptions`), so Babel's root mode "root" looks for
// `babel.config.*` in that directory only, and a file-relative config (`.babelrc*`, a `babel` key in
// `package.json`) applies to the files of the root's own package (`babelrcRoots` defaults to the
// root). The check is made once per project, by name, with no `@babel/core`.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

function hasBabelKey(packageJson: string): boolean {
  let text: string
  try {
    text = readFileSync(packageJson, 'utf8')
  } catch {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Reflect.get(parsed, 'babel') != null
    )
  } catch {
    return false
  }
}

/**
 * Whether `rootDir` has a Babel config that babel-jest would load: a `babel.config.*` or a
 * `.babelrc*` there, or a `babel` key in its `package.json`.
 * @internal
 */
export function hasBabelConfig(rootDir: string): boolean {
  for (const name of ROOT_CONFIGS) if (existsSync(join(rootDir, name))) return true
  for (const name of RELATIVE_CONFIGS) if (existsSync(join(rootDir, name))) return true
  return hasBabelKey(join(rootDir, 'package.json'))
}
