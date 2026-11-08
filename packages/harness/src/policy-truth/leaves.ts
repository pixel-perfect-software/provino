// A dialect's policy as a flat list of leaves (T1.7): every key path that holds a value rather than
// a group of keys. Groups are plain objects that are not a `ModuleRef` (`@provino/policy`'s rule
// for `diffPolicy`); arrays, refs, `null` and primitives are leaves. The hoisting rules a dialect
// gives its loader (`Dialect.loader.hoist`) are listed under `hoist.`, beside the ten slices.
import { isModuleRef } from '@provino/policy'

function isGroup(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && !isModuleRef(value)
}

/** Every leaf of `value` under `prefix`, by dotted path, in key order. */
export function policyLeaves(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const walk = (inner: unknown, path: string): void => {
    if (isGroup(inner)) {
      for (const key of Object.keys(inner).toSorted()) {
        walk(inner[key], path === '' ? key : `${path}.${key}`)
      }
      return
    }
    out.set(path, inner)
  }
  walk(value, prefix)
  return out
}

/**
 * A copy of `value` with the leaf at `path` (dotted, relative to `value`) replaced. Groups on the
 * way are copied; everything else is shared.
 */
export function withLeaf<T>(value: T, path: string, leaf: unknown): T {
  const [head, ...rest] = path.split('.')
  if (head === undefined || !isGroup(value)) throw new Error(`no group at "${path}"`)
  if (!Object.hasOwn(value, head)) throw new Error(`no key "${head}" in "${path}"`)
  const next = rest.length === 0 ? leaf : withLeaf(value[head], rest.join('.'), leaf)
  return { ...value, [head]: next } as T
}

/**
 * The claim that covers a leaf: the claim for its own path, else for the nearest group above it
 * (`mock.messages` covers `mock.messages.spy-missing`). `undefined` when none does.
 */
export function coveringKey(
  leaf: string,
  claimed: ReadonlySet<string> | readonly string[],
): string | undefined {
  const keys = claimed instanceof Set ? claimed : new Set(claimed)
  const parts = leaf.split('.')
  for (let end = parts.length; end > 0; end--) {
    const candidate = parts.slice(0, end).join('.')
    if (keys.has(candidate)) return candidate
  }
  return undefined
}
