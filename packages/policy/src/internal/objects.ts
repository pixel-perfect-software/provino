import type { ModuleRef } from '@provino/types'

/** @internal */
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Whether a value is a `ModuleRef`: a plain object with string `module` and `export` and no other
 * own keys. Re-exported publicly from `module-ref.ts`.
 * @public
 */
export function isModuleRef(value: unknown): value is ModuleRef {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    typeof value.module === 'string' &&
    typeof value.export === 'string'
  )
}

/**
 * Whether a value is a group of policy keys: a plain object that isn't a `ModuleRef`.
 * @internal
 */
export function isGroup(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainObject(value) && !isModuleRef(value)
}

/**
 * Copies plain objects and arrays all the way down, so a result never aliases a caller's value.
 * Other values (functions, RegExps, primitives) are shared as they are.
 * @internal
 */
export function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // defineProperty, so a `__proto__` key stays data instead of setting the prototype.
    Object.defineProperty(out, key, {
      value: copyValue(item),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/**
 * Freezes plain objects and arrays all the way down. Other objects (RegExp, Map, …) are left
 * as they are.
 * @internal
 */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    Object.freeze(value)
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** @internal */
export function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`
}
