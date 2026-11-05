import { forEachModuleRef, isImportableLocation, isModuleRef } from '@provino/policy'
import type { SerializedProjectConfig } from '@provino/types'
import { ConfigError } from '../errors.ts'
import { describe, isRecord, messageOf } from './input.ts'

/** Whether a value is a plain `{ module: string, export: string }` and nothing else. */
function isRefShape(value: unknown): value is { readonly module: string; readonly export: string } {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  // The environment ref also carries `options`.
  if (Object.keys(value).length !== (Object.hasOwn(value, 'options') ? 3 : 2)) return false
  return isModuleRef({ module: value.module, export: value.export })
}

/**
 * The worker imports a ref's `module` as it is (D21), so it must be an absolute path or a URL:
 * the same rule as the worker's (`isImportableLocation`). A bare or relative specifier would
 * resolve from the worker's own location, not the project's.
 */
function checkModule(module: string, path: string): void {
  if (isImportableLocation(module)) return
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

/**
 * What the policy walk stops at: a function (which can't cross, and which `serializePolicy` only
 * catches in plain objects), or any object holding both `module` and `export`, which is meant as
 * a ref and checked as one even when malformed.
 */
function isRefOrFunction(value: unknown): value is object {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && 'module' in value && 'export' in value)
  )
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
  forEachModuleRef(
    config.policy,
    'policy',
    (ref, path) => {
      if (typeof ref === 'function') {
        throw new ConfigError(
          'CONFIG_INVALID',
          `${path} is a function, which can't cross to a worker; give it as a { module, export } ref`,
        )
      }
      checkRef(ref, path)
    },
    isRefOrFunction,
  )
  if (config.globals !== null) checkRef(config.globals, 'globals')
  checkRef(config.environment, 'environment')
  try {
    structuredClone(config)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the worker config can't be cloned to a worker: ${messageOf(cause)}`,
      { cause },
    )
  }
}
