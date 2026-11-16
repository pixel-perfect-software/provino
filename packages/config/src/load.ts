import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfigEnv, ProvinoConfigInput } from '@provino/types'
import { ConfigError } from './errors.ts'
import { describe, isRecord } from './internal/input.ts'
import { type ResolvedProject, type ResolveProjectOptions, resolveProject } from './resolve.ts'

/** What `loadProject` does when the caller gives no `ConfigEnv`. */
const DEFAULT_ENV: ConfigEnv = Object.freeze({ command: 'run', mode: 'test' })

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
function freshUrl(file: string, cacheKey: string): string {
  delete nodeRequire.cache[cacheKey]
  const url = pathToFileURL(file)
  url.searchParams.set('provino-load', randomUUID())
  return url.href
}

/**
 * The fresh load of each file that hasn't settled yet, by real path (the key of Node's CommonJS
 * cache, so two spellings of one file share an entry). An `import()` of a CommonJS file puts the
 * file's module in that cache when it reads the file, and checks, when it runs it, that the entry
 * is still that module: Node 24's `loadCJSModuleWithModuleLoad` (`internal/modules/esm/translators`)
 * asserts it, and the failure is `ERR_INTERNAL_ASSERTION`. A second fresh load of the same file in
 * between deletes that entry (`freshUrl`), so the loads of one file run one after another: two
 * `run()` calls that overlap on one config file reach it. It lives at module level because the
 * cache it guards is the process's, and it holds a file only while a load of that file is running.
 */
const loading = new Map<string, Promise<void>>()

/**
 * The key of `file` in Node's CommonJS cache, which is also the key of `loading`: what
 * `require.resolve` gives, the file's real path. A file that doesn't resolve is cached under
 * nothing, so it is its own key, and the import says why it can't be read.
 */
function cacheKeyOf(file: string): string {
  try {
    return nodeRequire.resolve(file)
  } catch {
    return file
  }
}

/** `import()` of `freshUrl(file)`, after any fresh load of the same file still running. */
function importFresh(file: string): Promise<unknown> {
  const key = cacheKeyOf(file)
  const load = (loading.get(key) ?? Promise.resolve()).then(() => import(freshUrl(file, key)))
  const settled = load.then(
    () => undefined,
    () => undefined,
  )
  loading.set(key, settled)
  void settled.then(() => {
    if (loading.get(key) === settled) loading.delete(key)
  })
  return load
}

/**
 * A CommonJS file compiled from `export default` (tsc, Babel) sets `exports.__esModule = true` and
 * `exports.default = …`, which Node's ESM loader hands over as `default` = the whole `exports`
 * object. Unwraps it as Jest's `interopRequireDefault` does. Also how the coordinator reads the
 * default export of a global setup module (`@provino/orchestrator`).
 * @internal
 */
export function interopDefault(value: unknown): unknown {
  return isRecord(value) && value.__esModule === true && Object.hasOwn(value, 'default')
    ? value.default
    : value
}

/**
 * Imports a `provino.config.*` and returns its default export, unwrapped as
 * `interopRequireDefault` does for a CommonJS file compiled from `export default`: how
 * `loadConfigFile` reads it (build-plan §6). The Jest dialect reads Jest's files as jest-util's
 * `requireOrImportModule` does instead (cached, as in Jest). Node's own loader reads the file, so
 * `.mjs`, `.js` (per the nearest `package.json`'s `type`), `.mts` and `.ts` load as Node loads them
 * (type stripping needs Node 22.18+, or `--experimental-strip-types`). Every call reads the file
 * again (see `freshUrl`).
 *
 * Throws `ConfigError`: `CONFIG_LOAD_FAILED` when the import throws (the error is the `cause`),
 * `CONFIG_INVALID` when the module has no default export.
 */
async function importConfigModule(path: string): Promise<unknown> {
  const file = resolve(path)
  let namespace: unknown
  try {
    namespace = await importFresh(file)
  } catch (cause) {
    throw new ConfigError('CONFIG_LOAD_FAILED', `can't load the config file "${file}"`, { cause })
  }
  if (!isRecord(namespace) || !('default' in namespace)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the config file "${file}" has no default export; use "export default { … }"`,
    )
  }
  return interopDefault(namespace.default)
}

/**
 * Imports a config file and returns what its default export gives: the object itself, or what a
 * function (sync or async) returns when called with `env`. The import is `importConfigModule`'s,
 * so a file edited between two calls in one process gives the new contents (the modules it
 * imports are still cached by Node).
 *
 * Throws `ConfigError`: `CONFIG_LOAD_FAILED` when the import or the function throws (the error is
 * the `cause`), `CONFIG_INVALID` when there is no default export or it doesn't give an object. The
 * object's keys are checked by `resolveProject`.
 * @public
 */
export async function loadConfigFile(path: string, env: ConfigEnv): Promise<ProvinoConfigInput> {
  const file = resolve(path)
  let value = await importConfigModule(file)
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
