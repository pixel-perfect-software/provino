// The module shapes the loader hands out, by `ModulePolicy.interopDefault` (B13c Gap 3). Pure
// functions: the registry decides when to call them, these decide what a module looks like. The
// rules are the ones B13b's mod corpus recorded from real Jest 30.5 (`babel`) and Vitest 5.0
// (`node`), and the fake loader that matched those goldens; `interop.test.ts` pins each of them.
//
// - An ES module's exports object (what `import * as ns` and `require()` of it give): `babel` is
//   Babel's CommonJS output, a plain object with a non-enumerable `__esModule`; `node` is a
//   null-prototype `Module` namespace.
// - A CommonJS value seen through `import` (a namespace): `babel` is Babel's
//   `_interopRequireWildcard` (a value with `__esModule` is its own namespace; otherwise `default`
//   first, then the value's own enumerable keys, copied as they stand); `node` is Node's namespace
//   over CommonJS (every key sorted by name with `default` among them, `Module` tag), whatever the
//   value carries. Either way, a value that is already a `Module` namespace stays one.
// - What `requireActual`/`importActual` and an automock see of an ES module: getters over the live
//   exports, with a non-enumerable `__esModule` and the names sorted (`babel`), or a `Module` view in
//   source order (`node`).
import type { ModulePolicy } from '@provino/types'

/** `ModulePolicy.interopDefault`. */
export type Interop = ModulePolicy['interopDefault']

/** Namespaces already built for a CommonJS value, per interop: Babel caches its wildcard too. */
export interface InteropCache {
  readonly babel: WeakMap<object, object>
  readonly node: WeakMap<object, object>
}

export function createInteropCache(): InteropCache {
  return { babel: new WeakMap(), node: new WeakMap() }
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Whether `value` is a module namespace already (an ES module's, or one we built). */
export function isNamespace(value: unknown): boolean {
  return isObjectLike(value) && Reflect.get(value, Symbol.toStringTag) === 'Module'
}

/** A fresh exports object for one ES module instance. */
export function esmExports(interop: Interop): Record<string | symbol, unknown> {
  if (interop === 'babel') {
    const exports: Record<string | symbol, unknown> = {}
    Object.defineProperty(exports, '__esModule', { value: true })
    return exports
  }
  const namespace: Record<string | symbol, unknown> = Object.create(null)
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })
  return namespace
}

function copyKey(target: object, source: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor !== undefined) Object.defineProperty(target, key, descriptor)
}

/**
 * A CommonJS value (or a mocked module's value under `factoryShape: 'module-value'`) seen through
 * `import`. Built once per value and interop when `cache` is given.
 */
export function cjsNamespace(value: unknown, interop: Interop, cache?: InteropCache): object {
  if (!isObjectLike(value)) return { default: value }
  if (isNamespace(value)) return value
  if (interop === 'babel' && Reflect.get(value, '__esModule') === true) return value
  const known = cache?.[interop].get(value)
  if (known !== undefined) return known
  const namespace: Record<string | symbol, unknown> = Object.create(null)
  const keys = Object.keys(value).filter((key) => key !== 'default')
  if (interop === 'babel') {
    namespace.default = value
    for (const key of keys) copyKey(namespace, value, key)
  } else {
    for (const key of [...keys, 'default'].sort()) {
      if (key === 'default') namespace.default = value
      else copyKey(namespace, value, key)
    }
    Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })
  }
  cache?.[interop].set(value, namespace)
  return namespace
}

/** The view of an ES module's exports that the actual paths and automock get: getters over the live exports. */
export function actualView(exports: object, interop: Interop): object {
  const view: Record<string | symbol, unknown> = Object.create(null)
  if (interop === 'babel') Object.defineProperty(view, '__esModule', { value: true })
  else Object.defineProperty(view, Symbol.toStringTag, { value: 'Module' })
  const keys = Object.keys(exports)
  for (const key of interop === 'babel' ? keys.sort() : keys) {
    Object.defineProperty(view, key, { enumerable: true, get: () => Reflect.get(exports, key) })
  }
  return view
}
