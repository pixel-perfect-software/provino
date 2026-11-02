import type { Policy, SerializedPolicy } from '@provino/types'
import { PolicyError } from './errors.ts'
import { deepFreeze, isPlainObject, joinPath } from './internal/objects.ts'
import { isModuleRef } from './module-ref.ts'

/**
 * Turns a policy into what crosses coordinator → worker: data keys as they are, behaviour keys as
 * plain `{ module, export }` refs. The result survives `structuredClone`.
 *
 * A closure in a behaviour key can't cross a thread, and dropping it would leave the worker
 * without that behaviour, so it throws `PolicyError` `POLICY_CLOSURE_NOT_SERIALIZABLE` naming the
 * key. Give behaviour that runs in workers as a `ModuleRef`.
 * @public
 */
export function serializePolicy(policy: Policy): SerializedPolicy {
  // Every behaviour key was checked to be a ModuleRef, which is what SerializedPolicy says.
  return deepFreeze(serialize(policy, '') as SerializedPolicy)
}

function serialize(value: unknown, path: string): unknown {
  if (typeof value === 'function') {
    throw new PolicyError(
      'POLICY_CLOSURE_NOT_SERIALIZABLE',
      `policy key "${path}" is a closure, which can't cross to a worker; give it as a ModuleRef`,
      { path },
    )
  }
  if (isModuleRef(value)) return { module: value.module, export: value.export }
  if (Array.isArray(value)) return value.map((item, i) => serialize(item, `${path}[${i}]`))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = serialize(item, joinPath(path, key))
    return out
  }
  return value
}
