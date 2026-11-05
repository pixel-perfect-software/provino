import { isAbsolute } from 'node:path'
import type { SerializedProjectConfig } from '@provino/types'
import { ConfigError } from '../errors.ts'
import { describe, isRecord } from './input.ts'

/** Whether a value is a plain `{ module: string, export: string }` and nothing else. */
function isRefShape(value: unknown): value is { readonly module: string; readonly export: string } {
  return (
    isRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === (Object.hasOwn(value, 'options') ? 3 : 2) &&
    typeof value.module === 'string' &&
    typeof value.export === 'string'
  )
}

/**
 * The worker imports a ref's `module` as it is (D21), so it must be an absolute path or a URL:
 * the same rule as the worker's `moduleLocation`. A bare or relative specifier would resolve from
 * the worker's own location, not the project's.
 */
function checkModule(module: string, path: string): void {
  if (isAbsolute(module) || URL.canParse(module)) return
  throw new ConfigError(
    'CONFIG_INVALID',
    `${path}.module must be an absolute path or a URL such as a file: URL (got ${describe(module)}); a worker can't resolve a package specifier or a relative path`,
  )
}

/** Checks one ref at `path`. `ref` is a value from a dialect or the caller, so nothing is trusted. */
function checkRef(ref: unknown, path: string): void {
  if (!isRefShape(ref)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${path} must be a { module, export } ref, since a function can't cross to a worker (got ${describe(ref)})`,
    )
  }
  checkModule(ref.module, path)
}

/** A policy ref is exactly `{ module, export }`: any object holding both string keys is one. */
function looksLikeRef(value: object): boolean {
  return 'module' in value && 'export' in value
}

function walkPolicy(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === 'function') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${path} is a function, which can't cross to a worker; give it as a { module, export } ref`,
    )
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      walkPolicy(item, `${path}[${index}]`, seen)
    })
    return
  }
  if (looksLikeRef(value)) {
    checkRef(value, path)
    return
  }
  for (const [key, item] of Object.entries(value)) walkPolicy(item, `${path}.${key}`, seen)
}

/**
 * Checks that the finished worker config is something every worker can use, so a bad one is a
 * config error (exit 2) and not a failure in each worker (exit 1): every `{ module, export }` ref
 * in the policy, the globals ref and the environment ref has a plain shape and an absolute
 * `module`, and the whole config survives `structuredClone`. Throws `CONFIG_INVALID` naming the
 * key path.
 * @internal
 */
export function assertWorkerConfig(config: SerializedProjectConfig): void {
  walkPolicy(config.policy, 'policy', new Set())
  if (config.globals !== null) checkRef(config.globals, 'globals')
  checkRef(config.environment, 'environment')
  try {
    structuredClone(config)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the worker config can't be cloned to a worker: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}
