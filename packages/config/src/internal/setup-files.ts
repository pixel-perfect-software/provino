import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from '../errors.ts'
import { kindOf } from './kind.ts'

const RELATIVE = /^\.\.?(?:[/\\]|$)/

/** How a package specifier resolves: the export conditions of an import, and the extensions tried. */
export interface PackageResolution {
  readonly conditions: readonly string[]
  readonly extensions: readonly string[]
}

/**
 * A package specifier from `rootDir` as an import resolves it (`@provino/resolver`, with
 * `conditions`), else as `require.resolve` does (a package that only a `require` condition or
 * `main` reaches); `undefined` when neither finds it. The resolver is imported only here, so a
 * project with no package specifier loads none.
 */
async function resolvePackage(
  entry: string,
  rootDir: string,
  resolution: PackageResolution,
): Promise<string | undefined> {
  const importer = join(rootDir, 'noop.js')
  try {
    const { createResolver } = await import('@provino/resolver')
    const resolver = createResolver({
      root: rootDir,
      mappers: [],
      extensions: resolution.extensions,
      tsconfig: false,
    })
    const result = resolver.resolve(entry, {
      importer,
      kind: 'import',
      conditions: resolution.conditions,
    })
    if (result.type === 'file') return result.path
  } catch {
    // Not found, or not resolvable this way: the `require` fallback below.
  }
  try {
    return createRequire(importer).resolve(entry)
  } catch {
    return undefined
  }
}

/** One `setupFiles` entry as an absolute path, or `CONFIG_INVALID` for what can't be one. */
async function setupPath(
  entry: string,
  rootDir: string,
  key: string,
  resolution: PackageResolution,
): Promise<string> {
  if (entry.startsWith('file:')) {
    try {
      return fileURLToPath(entry)
    } catch (cause) {
      throw new ConfigError('CONFIG_INVALID', `${key} is not a usable file: URL`, { cause })
    }
  }
  if (isAbsolute(entry) || RELATIVE.test(entry)) return resolve(rootDir, entry)
  if (entry.startsWith('<')) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${key} must be a relative path (./ or ../), an absolute path, a file: URL or a package specifier; a <rootDir> token isn't supported`,
    )
  }
  const found = await resolvePackage(entry, rootDir, resolution)
  if (found === undefined) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${key} isn't a path or a package that resolves from "${rootDir}"`,
    )
  }
  return found
}

/**
 * The `setupFiles` entries as absolute paths, each checked to be a file, so a typo is a config
 * error and not a failure in every worker that blames the test file.
 * @internal
 */
export async function resolveSetupFiles(
  entries: readonly string[],
  rootDir: string,
  name: string,
  resolution: PackageResolution,
): Promise<readonly string[]> {
  return Promise.all(
    entries.map(async (entry, index) => {
      const key = `config key "${name}[${index}]" (${JSON.stringify(entry)})`
      const path = await setupPath(entry, rootDir, key, resolution)
      if ((await kindOf(path)) !== 'file')
        throw new ConfigError('CONFIG_INVALID', `${key} isn't a file: "${path}"`)
      return path
    }),
  )
}
