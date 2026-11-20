import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from '../errors.ts'

const RELATIVE = /^\.\.?(?:[/\\]|$)/

/** One `setupFiles` entry as an absolute path, or `CONFIG_INVALID` for what can't be one. */
function setupPath(entry: string, rootDir: string, key: string): string {
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
  // A package specifier, resolved from the project root as `require.resolve` does (the root's own
  // `node_modules`, then its ancestors').
  try {
    return createRequire(join(rootDir, 'noop.js')).resolve(entry)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${key} isn't a path or a package that resolves from "${rootDir}"`,
      { cause },
    )
  }
}

/**
 * The `setupFiles` entries as absolute paths, each checked to be a file, so a typo is a config
 * error and not a failure in every worker that blames the test file.
 * @internal
 */
export async function resolveSetupFiles(
  entries: readonly string[],
  rootDir: string,
  name = 'setupFiles',
): Promise<readonly string[]> {
  return Promise.all(
    entries.map(async (entry, index) => {
      const key = `config key "${name}[${index}]" (${JSON.stringify(entry)})`
      const path = setupPath(entry, rootDir, key)
      let isFile = false
      try {
        isFile = (await stat(path)).isFile()
      } catch {
        // Missing or unreadable: reported below with the path.
      }
      if (!isFile) throw new ConfigError('CONFIG_INVALID', `${key} isn't a file: "${path}"`)
      return path
    }),
  )
}
