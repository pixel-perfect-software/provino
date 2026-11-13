// T3.7: Node's own compile cache (`module.enableCompileCache`), behind the same switch as the vm
// cache. It covers the modules Node compiles itself (the umbrella's chunks, the worker's own code),
// not a `vm.Script`; `createV8Cache` covers those.
import * as nodeModule from 'node:module'
import { resolve } from 'node:path'
import { writeCacheTag } from '../cache/store.ts'
import type { CacheMode } from './mode.ts'

/**
 * What `enableNativeCompileCache` found.
 * @public
 */
export interface NativeCompileCacheResult {
  /**
   * `enabled`: this call turned the cache on. `already-enabled`: it was on (`NODE_COMPILE_CACHE`,
   * or an earlier call). `disabled`: the mode is `'off'`, or Node's `NODE_DISABLE_COMPILE_CACHE`
   * is set. `unsupported`: this Node has no `module.enableCompileCache`. `failed`: Node tried and
   * couldn't (`message` says why).
   */
  readonly status: 'enabled' | 'already-enabled' | 'disabled' | 'unsupported' | 'failed'
  /** The directory Node is using (it adds a per-Node-version directory under the one given). */
  readonly directory?: string
  /** Node's reason for `failed`. */
  readonly message?: string
}

/** What `module.enableCompileCache` returns. */
interface NodeResult {
  readonly status: number
  readonly message?: string
  readonly directory?: string
}

/** The two shapes of its argument: Node 22's types know only the string. */
type EnableCompileCache = (
  options?: string | { readonly directory?: string; readonly portable?: boolean },
) => NodeResult

/**
 * Which form of `module.enableCompileCache`'s argument this Node takes: the object form
 * (`{ directory, portable }`, which makes the cache relocatable) from Node 24.12 and from 25; a
 * plain string before (Node 22.23 throws `ERR_INVALID_ARG_TYPE` on the object). A version that
 * doesn't parse gets the string, which every Node with the function takes.
 * @internal
 */
export function compileCacheArgumentForm(nodeVersion: string): 'string' | 'object' {
  const match = /^v?(\d+)\.(\d+)/.exec(nodeVersion)
  if (match === null) return 'string'
  const major = Number(match[1])
  const minor = Number(match[2])
  return major >= 25 || (major === 24 && minor >= 12) ? 'object' : 'string'
}

/**
 * Turns on Node's compile cache in `dir`, when `mode` is `'on'` and this Node has it. Never
 * throws: every outcome is in the result. It is process-global, so call it once, early, from the
 * process that should use it. A new `dir` gets a `CACHEDIR.TAG` (the one the transform cache
 * writes), so backup tools skip it.
 * @public
 */
export function enableNativeCompileCache(
  dir: string,
  mode: CacheMode = 'on',
): NativeCompileCacheResult {
  if (mode === 'off') return { status: 'disabled' }
  const enable: unknown = nodeModule.enableCompileCache
  if (typeof enable !== 'function') return { status: 'unsupported' }
  const call = enable as EnableCompileCache
  const directory = resolve(dir)
  let result: NodeResult
  try {
    if (compileCacheArgumentForm(process.versions.node) === 'object') {
      try {
        result = call({ directory, portable: true })
      } catch {
        result = call(directory)
      }
    } else {
      result = call(directory)
    }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  const status = nodeModule.constants.compileCacheStatus
  if (result.status === status.ENABLED) {
    writeCacheTag(directory)
    return withDetails('enabled', result)
  }
  if (result.status === status.ALREADY_ENABLED) return withDetails('already-enabled', result)
  if (result.status === status.DISABLED) return withDetails('disabled', result)
  return withDetails('failed', result)
}

function withDetails(
  status: NativeCompileCacheResult['status'],
  result: NodeResult,
): NativeCompileCacheResult {
  return {
    status,
    ...(result.directory === undefined ? {} : { directory: result.directory }),
    ...(result.message === undefined ? {} : { message: result.message }),
  }
}
