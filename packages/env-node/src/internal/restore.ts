// The property snapshot behind `nodeEnvironment`'s teardown (T8.2, node part). It works on any
// object, so the tests can plant a non-configurable property on a plain object instead of on the
// real global.
import { NodeEnvironmentError, type RestoreFailure } from '../errors.ts'

/**
 * An object's own properties as they were, and the way back to them.
 * @internal
 */
export interface PropertySnapshot {
  /**
   * Puts the object's own properties back as captured, and returns the ones it could not: a key
   * added since that is not configurable cannot be deleted, and a changed one whose original
   * descriptor can no longer be defined (it became non-writable and non-configurable) cannot be
   * redefined. Everything else is restored whatever the failures.
   *
   * Property order is not part of the contract. A key that was deleted and restored is re-added
   * after every key that was never deleted (a property cannot be inserted in the middle), so it
   * moves to the end of its group: string keys, then symbols. The keys that were never deleted
   * keep their order. Reordering them back would mean deleting and re-adding every key after the
   * first gap, which the non-configurable ones (`NaN`, `undefined`, `Infinity`) do not allow.
   */
  restore(): readonly RestoreFailure[]
}

/**
 * Captures every own property of `target` (string and symbol keys) with its descriptor.
 *
 * Reading a descriptor can run code. V8 backs some of Node's globals with lazy data properties
 * (`Headers`, `fetch` and the other undici ones): the first descriptor read, not only the first
 * value read, loads their module, and undici defines two non-configurable symbol properties on
 * the global as it loads. The capture therefore reads descriptors until a pass finds no new key,
 * so those properties are part of the baseline and a file that later uses `fetch` does not add
 * keys the restore could not delete. The first capture in a process loads them (21 ms on Node
 * 24.22, `local`); later ones take about 0.05 ms.
 *
 * A property defined as an accessor is captured as an accessor and never called. Node's lazy
 * getters that replace themselves with a value property on first access are restored to the
 * original getter, which is harmless: it replaces itself again on its next access.
 * @internal
 */
export function snapshotProperties(target: object): PropertySnapshot {
  const originals = new Map<string | symbol, PropertyDescriptor>()
  for (let grew = true; grew; ) {
    grew = false
    for (const key of Reflect.ownKeys(target)) {
      if (originals.has(key)) continue
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      if (descriptor === undefined) continue
      originals.set(key, descriptor)
      grew = true
    }
  }
  return {
    restore(): readonly RestoreFailure[] {
      const failures: RestoreFailure[] = []
      for (const key of Reflect.ownKeys(target)) {
        if (!originals.has(key) && !Reflect.deleteProperty(target, key)) {
          failures.push({ key, action: 'delete' })
        }
      }
      // In capture order, so keys deleted during the file come back in their original order.
      for (const [key, original] of originals) {
        if (isSame(original, Reflect.getOwnPropertyDescriptor(target, key))) continue
        if (!Reflect.defineProperty(target, key, original))
          failures.push({ key, action: 'redefine' })
      }
      return failures
    },
  }
}

/** Same kind, same value or accessor functions (by identity), same flags. */
function isSame(original: PropertyDescriptor, current: PropertyDescriptor | undefined): boolean {
  return (
    current !== undefined &&
    Object.is(original.value, current.value) &&
    original.get === current.get &&
    original.set === current.set &&
    original.writable === current.writable &&
    original.enumerable === current.enumerable &&
    original.configurable === current.configurable
  )
}

/**
 * Restores `snapshot`, then throws `ENV_NODE_RESTORE_FAILED` if any key could not be restored.
 * The throw comes after the restore, so one stuck key never leaves the others changed.
 * @internal
 */
export function restoreOrThrow(snapshot: PropertySnapshot): void {
  const failures = snapshot.restore()
  if (failures.length === 0) return
  const keys = failures.map(({ key, action }) => `${String(key)} (${action})`).join(', ')
  throw new NodeEnvironmentError(
    'ENV_NODE_RESTORE_FAILED',
    `Could not restore the global after the file; every other property was restored. The next file in this worker will see: ${keys}. The isolation tier 'realm' gives each file its own global.`,
    { failures },
  )
}
