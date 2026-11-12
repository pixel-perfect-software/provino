// The property snapshot behind every environment's teardown (T8.2, node part; shared by
// `nodeEnvironment` and the Jest environment adapter, D71). It works on any object, so the tests
// can plant a non-configurable property on a plain object instead of on the real global.

/**
 * An object's own properties as they were, and the way back to them.
 * @public
 */
export interface PropertySnapshot {
  /**
   * Puts the object's own properties back as captured, and returns the keys it could not restore:
   * a key added since that is not configurable cannot be deleted, a changed one whose original
   * descriptor can no longer be defined (it became non-writable and non-configurable) cannot be
   * redefined, and an accessor whose old value is unknown or refuses to take it back cannot be
   * reset. Everything else is restored whatever the leaks, and nothing here throws for them
   * (decision D22: the caller reports the keys, it does not fail the file). A non-configurable
   * symbol that a package loaded mid-file defines once per process and never removes (graceful-fs's
   * queue, undici's dispatchers) is not a leak and is not returned.
   *
   * Property order is not part of the contract. A key that was deleted and restored is re-added
   * after every key that was never deleted (a property cannot be inserted in the middle), so it
   * moves to the end of its group: string keys, then symbols. The keys that were never deleted
   * keep their order. Reordering them back would mean deleting and re-adding every key after the
   * first gap, which the non-configurable ones (`NaN`, `undefined`, `Infinity`) do not allow.
   */
  restore(): readonly (string | symbol)[]
}

/**
 * What a wrapped setter saw the first time it ran: nothing yet, the accessor's value before the
 * assignment, or a getter that threw so the old value is unknown.
 */
type Seen =
  | { readonly kind: 'untouched' }
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'unreadable' }

/** An accessor whose setter is wrapped for the length of the snapshot. */
interface WrappedAccessor {
  readonly key: string | symbol
  readonly set: (value: unknown) => void
  seen: Seen
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
 * A descriptor does not show an accessor's state. Node defines `process`, `Buffer` and
 * `performance` (and on Node 26 `localStorage` and `sessionStorage`) as get/set accessors whose
 * value lives in a closure, so `globalThis.process = fake` changes the closure and leaves the
 * descriptor identical. Each configurable accessor with both sides therefore gets a wrapped
 * setter until `restore`. On its first call the wrapper reads the getter, which records the old
 * value, then calls the original setter. `restore` calls the original setter with the old value
 * for every wrapper that ran, then puts the original descriptor back, so the wrapper never
 * outlives the snapshot. A getter is read only when something assigned: Node 26's `localStorage`
 * getter warns. Every other accessor is captured as an accessor and never called, and Node's
 * lazy getters that replace themselves with a value on first access are restored to the original
 * getter, which is harmless: it replaces itself again on its next access.
 * @public
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
  const wrapped = wrapSetters(target, originals)
  return {
    restore(): readonly (string | symbol)[] {
      const leaked = new Set<string | symbol>()
      for (const key of Reflect.ownKeys(target)) {
        if (!originals.has(key) && !deleted(target, key) && !isProcessSingleton(key))
          leaked.add(key)
      }
      // Before the descriptors go back: a setter that ran changed state the descriptor does not
      // show, whether or not the test later redefined or deleted the key. Emptied, so a second
      // restore has nothing to replay.
      for (const { key, set, seen } of wrapped.splice(0)) {
        if (seen.kind === 'untouched') continue
        if (seen.kind === 'unreadable' || !assign(set, target, seen.value)) leaked.add(key)
      }
      // In capture order, so keys deleted during the file come back in their original order.
      for (const [key, original] of originals) {
        if (isSame(original, Reflect.getOwnPropertyDescriptor(target, key))) continue
        if (!Reflect.defineProperty(target, key, original)) leaked.add(key)
      }
      return [...leaked]
    },
  }
}

/** Whether `key` is gone from `target`; a property that cannot be deleted, or a trap that throws, is not. */
function deleted(target: object, key: string | symbol): boolean {
  try {
    return Reflect.deleteProperty(target, key)
  } catch {
    return false
  }
}

/**
 * Symbols a package loaded by a test defines on the global once per process and never removes
 * (graceful-fs's queue, undici's dispatchers). The next file's baseline holds them.
 */
function isProcessSingleton(key: string | symbol): boolean {
  return typeof key === 'symbol' && /^(graceful-fs\.queue|undici\.)/.test(key.description ?? '')
}

/** Wraps the setter of every configurable accessor in `originals` that has both a getter and a setter. */
function wrapSetters(
  target: object,
  originals: ReadonlyMap<string | symbol, PropertyDescriptor>,
): WrappedAccessor[] {
  const wrapped: WrappedAccessor[] = []
  for (const [key, original] of originals) {
    const { get, set } = original
    if (get === undefined || set === undefined || original.configurable !== true) continue
    const accessor: WrappedAccessor = { key, set, seen: { kind: 'untouched' } }
    const wrapper = recordingSetter(accessor, get, target)
    if (Reflect.defineProperty(target, key, { ...original, set: wrapper })) wrapped.push(accessor)
  }
  return wrapped
}

/**
 * A setter that, on its first call, records the accessor's old value into `accessor.seen`, then
 * calls the original setter with the caller's receiver and value.
 */
function recordingSetter(
  accessor: WrappedAccessor,
  get: () => unknown,
  target: object,
): (this: unknown, value: unknown) => void {
  return function (this: unknown, value: unknown): void {
    if (accessor.seen.kind === 'untouched') accessor.seen = readOnce(get, target)
    Reflect.apply(accessor.set, this, [value])
  }
}

/** The accessor's value before the first assignment, or `unreadable` if its getter throws. */
function readOnce(get: () => unknown, target: object): Seen {
  try {
    return { kind: 'value', value: Reflect.apply(get, target, []) }
  } catch {
    // The assignment still goes through as it would have; the key is reported as not restorable.
    return { kind: 'unreadable' }
  }
}

/** Calls `set` on `target`; false if it threw. */
function assign(set: (value: unknown) => void, target: object, value: unknown): boolean {
  try {
    Reflect.apply(set, target, [value])
    return true
  } catch {
    return false
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
