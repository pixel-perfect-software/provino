import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
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
  throw new ConfigError(
    'CONFIG_INVALID',
    `${key} must be a relative path (./ or ../), an absolute path or a file: URL; package specifiers and <rootDir> tokens in setupFiles aren't supported yet (T1.4)`,
  )
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
