import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfigEnv, ProvinoConfigInput } from '@provino/types'
import { ConfigError } from './errors.ts'
import { describe, isRecord } from './internal/input.ts'
import { type ResolvedProject, type ResolveProjectOptions, resolveProject } from './resolve.ts'

/** What `loadProject` does when the caller gives no `ConfigEnv`. */
const DEFAULT_ENV: ConfigEnv = { command: 'run', mode: 'test' }

/** `require.cache` is Node's CommonJS module cache, which the ESM loader's CommonJS path shares. */
const nodeRequire = createRequire(import.meta.url)

/**
 * Makes the next `import()` of `file` read it from disk, not from a module Node already holds.
 * Node caches by URL, so a query string the file never sees gives an ESM file (`.mjs`, `.mts`,
 * and `.js` or `.ts` under a package of type `module`) a URL of its own: it is read and run
 * again. Node's CommonJS loader ignores the query and keys its cache by file name, so for a
 * CommonJS file (`.cjs`, `.cts`, and `.js` or `.ts` under a package of type `commonjs`) the entry
 * is dropped from that cache as well.
 *
 * Each load stays in the ESM module map for the life of the process, since Node can't unload a
 * module. That is a small, accepted leak for config files. Only the config file itself is busted:
 * a module it imports or requires is still served from Node's caches.
 */
function freshUrl(file: string): string {
  try {
    delete nodeRequire.cache[nodeRequire.resolve(file)]
  } catch {
    // Not resolvable, so nothing is cached under it; the import below reports why the file can't
    // be read.
  }
  const url = pathToFileURL(file)
  url.searchParams.set('provino-load', randomUUID())
  return url.href
}

/**
 * Imports a config file and returns what its default export gives: the object itself, or what a
 * function (sync or async) returns when called with `env`. Node's own loader reads the file, so
 * `.mjs`, `.js` (per the nearest `package.json`'s `type`), `.mts` and `.ts` load as Node loads
 * them (type stripping needs Node 22.18+, or `--experimental-strip-types`). Every call reads the
 * file again, so a file edited between two calls in one process gives the new contents (the
 * modules it imports are still cached by Node).
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
    namespace = await import(freshUrl(file))
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
