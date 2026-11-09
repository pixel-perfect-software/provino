import type { Policy, PolicyAtom, PolicyOverrides } from '@provino/types'
import { PolicyError } from './errors.ts'
import { copyValue, deepFreeze, isGroup, isPlainObject, joinPath } from './internal/objects.ts'
import { neutralPolicy } from './neutral.ts'

/** Dotted paths of the keys in `T` typed as records (index signatures, such as `mock.messages`). */
type RecordPaths<T, Prefix extends string = ''> = T extends PolicyAtom
  ? never
  : string extends keyof T
    ? Prefix
    : {
        [K in keyof T & string]: RecordPaths<T[K], Prefix extends '' ? K : `${Prefix}.${K}`>
      }[keyof T & string]

/**
 * The record keys: their keys are data, not a fixed shape, so a layer that sets one replaces it
 * whole, like an array. The type check below fails, naming the path, if a record key in `Policy`
 * is missing here.
 */
const RECORD_PATHS = [
  'mock.messages',
  'module.messages',
  'orchestrator.isolationDefault.byEnvironment',
  'snapshot.format.extra',
] as const satisfies readonly RecordPaths<Policy>[]
type UnlistedRecord = Exclude<RecordPaths<Policy>, (typeof RECORD_PATHS)[number]>
const _everyRecordListed: [UnlistedRecord] extends [never] ? true : UnlistedRecord = true
const RECORDS: ReadonlySet<string> = new Set(RECORD_PATHS)

/**
 * Resolves policy layers over `neutralPolicy`, lowest first: `resolvePolicy(dialect, project,
 * facade)`. Groups of keys merge key by key. Every other value (an array, a record, a
 * `ModuleRef`, a function, a primitive) replaces the lower layer's value whole. The result is a
 * new, deeply frozen policy; layers are copied, never frozen or changed.
 *
 * Checks keys and shape, not leaf types: `POLICY_UNKNOWN_KEY` for a key the policy doesn't have,
 * `POLICY_INVALID_LAYER` for a value where a group belongs or a group where a value belongs.
 * A wrong leaf type (`maxConcurrency: 'lots'`) gets through, so config readers validate values
 * before layering them (T1.4).
 * @public
 */
export function resolvePolicy(...layers: readonly (PolicyOverrides | undefined)[]): Policy {
  let resolved: unknown = neutralPolicy
  for (const layer of layers) {
    if (layer !== undefined) resolved = merge(resolved, layer, '')
  }
  // Every layer was checked against neutralPolicy's keys and group shape (see above).
  return deepFreeze(resolved as Policy)
}

function merge(base: unknown, layer: unknown, path: string): unknown {
  if (RECORDS.has(path)) {
    if (!isPlainObject(layer)) throw invalid(path, 'a record; a layer must give it an object')
    return copyValue(layer)
  }
  if (!isGroup(base)) {
    if (isGroup(layer)) throw invalid(path, 'a value; a layer must not give it a group of keys')
    return copyValue(layer)
  }
  if (!isGroup(layer)) throw invalid(path, 'a group of keys; a layer must give it an object')
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(layer)) {
    const keyPath = joinPath(path, key)
    // Own keys only: `toString` or `__proto__` from a JSON layer is unknown, not inherited.
    if (!Object.hasOwn(base, key)) {
      throw new PolicyError('POLICY_UNKNOWN_KEY', `unknown policy key "${keyPath}"`, {
        path: keyPath,
      })
    }
    if (value !== undefined) out[key] = merge(base[key], value, keyPath)
  }
  return out
}

function invalid(path: string, what: string): PolicyError {
  return new PolicyError('POLICY_INVALID_LAYER', `policy key "${path}" is ${what}`, { path })
}
