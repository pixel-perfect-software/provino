/** @internal */
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
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
