import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfigEnv, ProvinoConfigInput } from '@provino/types'
import { ConfigError } from './errors.ts'
import { describe, isRecord } from './internal/input.ts'
import { type ResolvedProject, type ResolveProjectOptions, resolveProject } from './resolve.ts'

/** What `loadProject` does when the caller gives no `ConfigEnv`. */
const DEFAULT_ENV: ConfigEnv = { command: 'run', mode: 'test' }

/**
 * Imports a config file and returns what its default export gives: the object itself, or what a
 * function (sync or async) returns when called with `env`. Node's own loader reads the file, so
 * `.mjs`, `.js` (per the nearest `package.json`'s `type`), `.mts` and `.ts` load as Node loads
 * them (type stripping needs Node 22.18+, or `--experimental-strip-types`). Node caches an
 * imported module by URL, so loading the same path twice in one process returns the first
 * file's contents.
 *
 * Throws `ConfigError`: `CONFIG_LOAD_FAILED` when the import or the function throws (the error is
 * the `cause`), `CONFIG_INVALID` when there is no default export or it doesn't give an object. The
 * object's keys are checked by `resolveProject`.
 * @public
 */
export async function loadConfigFile(path: string, env: ConfigEnv): Promise<ProvinoConfigInput> {
  const file = resolve(path)
  let namespace: unknown
  try {
    namespace = await import(pathToFileURL(file).href)
  } catch (cause) {
    throw new ConfigError('CONFIG_LOAD_FAILED', `can't load the config file "${file}"`, { cause })
  }
  if (!isRecord(namespace) || !('default' in namespace)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the config file "${file}" has no default export; use "export default { … }"`,
    )
  }
  let value = namespace.default
  if (typeof value === 'function') {
    try {
      value = await value(env)
    } catch (cause) {
      throw new ConfigError('CONFIG_LOAD_FAILED', `the config function in "${file}" threw`, {
        cause,
      })
    }
  }
  if (!isRecord(value)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the config file "${file}" must export an object, or a function that returns one (got ${describe(value)})`,
    )
  }
  // A plain object from a user's file; `resolveProject` checks every key it reads.
  return value
}

/**
 * Loads the config file at `configPath` (made absolute against the working directory) and
 * resolves it: `loadConfigFile` then `resolveProject`. `env` defaults to
 * `{ command: 'run', mode: 'test' }`.
 * @public
 */
export async function loadProject(
  configPath: string,
  options: Omit<ResolveProjectOptions, 'configPath'> & { readonly env?: ConfigEnv },
): Promise<ResolvedProject> {
  const absolute = resolve(configPath)
  const { env, ...resolveOptions } = options
  const input = await loadConfigFile(absolute, env ?? DEFAULT_ENV)
  return resolveProject(input, { ...resolveOptions, configPath: absolute })
}
