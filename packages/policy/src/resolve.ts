import type { Policy, PolicyOverrides } from '@provino/types'
import { PolicyError } from './errors.ts'
import { deepFreeze, isPlainObject, joinPath } from './internal/objects.ts'
import { isModuleRef } from './module-ref.ts'
import { neutralPolicy } from './neutral.ts'

/** Objects whose keys are data, not a fixed shape: a layer may add keys to them. */
const OPEN_RECORDS: ReadonlySet<string> = new Set([
  'mock.messages',
  'orchestrator.isolationDefault.byEnvironment',
])

/**
 * Resolves policy layers over `neutralPolicy`, lowest first: `resolvePolicy(dialect, project,
 * facade)`. Objects merge key by key; arrays, `ModuleRef`s, functions and other values replace
 * the lower layer's value whole. Inputs are not changed; the result is a new, deeply frozen
 * policy.
 *
 * Throws `PolicyError` `POLICY_UNKNOWN_KEY` for a key the policy doesn't have, and
 * `POLICY_INVALID_LAYER` for a value where a group of keys belongs.
 * @public
 */
export function resolvePolicy(...layers: readonly (PolicyOverrides | undefined)[]): Policy {
  let resolved: unknown = neutralPolicy
  for (const layer of layers) {
    if (layer !== undefined) resolved = merge(resolved, layer, '')
  }
  // Every layer was checked against neutralPolicy's shape, so the result is a Policy.
  return deepFreeze(resolved as Policy)
}

function merge(base: unknown, layer: unknown, path: string): unknown {
  if (!isPlainObject(layer) || isModuleRef(layer)) {
    if (isGroup(base)) {
      throw new PolicyError(
        'POLICY_INVALID_LAYER',
        `policy key "${path}" is a group of keys; a layer must give it an object`,
        { path },
      )
    }
    return layer
  }
  if (!isGroup(base)) return layer
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(layer)) {
    const keyPath = joinPath(path, key)
    if (!(key in base) && !OPEN_RECORDS.has(path)) {
      throw new PolicyError('POLICY_UNKNOWN_KEY', `unknown policy key "${keyPath}"`, {
        path: keyPath,
      })
    }
    if (value !== undefined) out[key] = merge(base[key], value, keyPath)
  }
  return out
}

function isGroup(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainObject(value) && !isModuleRef(value)
}
