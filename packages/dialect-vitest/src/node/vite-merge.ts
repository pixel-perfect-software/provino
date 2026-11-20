// B25c: Vite's `mergeConfig` (vite 8's `mergeConfig` / `mergeConfigRecursively` / `mergeAlias`),
// which `vitest/config` re-exports, rebuilt so a config's `mergeConfig` call needs no Vite. Held to
// the real one by `vite-merge.test.ts`, in-process, over the cases below.

type Rec = Record<string, unknown>

function isObject(value: unknown): value is Rec {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function arraify<T>(value: T | readonly T[]): T[] {
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T]
}

interface AliasEntry extends Rec {
  find: unknown
  replacement: unknown
}

function normalizeSingleAlias(entry: Rec): AliasEntry {
  let find = entry.find
  let replacement = entry.replacement
  if (
    typeof find === 'string' &&
    find.endsWith('/') &&
    typeof replacement === 'string' &&
    replacement.endsWith('/')
  ) {
    find = find.slice(0, -1)
    replacement = replacement.slice(0, -1)
  }
  const alias: AliasEntry = { find, replacement }
  if (entry.customResolver !== undefined) alias.customResolver = entry.customResolver
  return alias
}

function normalizeAlias(value: unknown): AliasEntry[] {
  if (Array.isArray(value)) return value.map((entry) => normalizeSingleAlias(entry as Rec))
  if (isObject(value)) {
    return Object.keys(value).map((find) =>
      normalizeSingleAlias({ find, replacement: value[find] }),
    )
  }
  return []
}

function mergeAlias(a: unknown, b: unknown): unknown {
  if (!a) return b
  if (!b) return a
  if (isObject(a) && isObject(b)) return { ...a, ...b }
  // The later config's entries come first, as Vite does: the first match wins.
  return [...normalizeAlias(b), ...normalizeAlias(a)]
}

function mergeRecursively(defaults: Rec, overrides: Rec, rootPath: string): Rec {
  const merged: Rec = { ...defaults }
  for (const key of Object.keys(overrides)) {
    const value = overrides[key]
    if (value === undefined || value === null) continue
    const existing = merged[key]
    if (existing === undefined || existing === null) {
      merged[key] = value
      continue
    }
    if (key === 'alias' && (rootPath === 'resolve' || rootPath === '')) {
      merged[key] = mergeAlias(existing, value)
      continue
    }
    if (key === 'assetsInclude' && rootPath === '') {
      merged[key] = ([] as unknown[]).concat(existing, value)
      continue
    }
    if (
      key === 'noExternal' &&
      (rootPath === 'ssr' || rootPath === 'resolve') &&
      (existing === true || value === true)
    ) {
      merged[key] = true
      continue
    }
    if (key === 'plugins' && rootPath === 'worker') {
      const first = existing as () => unknown[]
      const second = value as () => unknown[]
      merged[key] = () => [...first(), ...second()]
      continue
    }
    if (key === 'server' && rootPath === 'server.hmr') {
      merged[key] = value
      continue
    }
    if (Array.isArray(existing) || Array.isArray(value)) {
      merged[key] = [...arraify(existing), ...arraify(value)]
      continue
    }
    if (isObject(existing) && isObject(value)) {
      merged[key] = mergeRecursively(existing, value, rootPath === '' ? key : `${rootPath}.${key}`)
      continue
    }
    merged[key] = value
  }
  return merged
}

/**
 * Merges two Vite-shaped configs as Vite's `mergeConfig` does: arrays concatenate, objects merge
 * recursively, `null` and `undefined` in the override are skipped, a scalar is replaced, and
 * `resolve.alias` entries of the override come first. A function (a config callback) is refused.
 * @public
 */
export function mergeConfig(defaults: Rec, overrides: Rec, isRoot = true): Rec {
  if (typeof defaults === 'function' || typeof overrides === 'function') {
    throw new Error('Cannot merge config in form of callback')
  }
  return mergeRecursively(defaults, overrides, isRoot ? '' : '.')
}
