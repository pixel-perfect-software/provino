// A restorable copy of an object's own properties, for the registry and for the statics
// `expect.extend` puts on `expect` and `expect.not`.

/**
 * Remembers every own property of `target` (string and symbol keys) with its descriptor, and
 * returns the function that puts `target` back: keys added since are deleted, and any key that is
 * gone or changed is defined again from its saved descriptor. The object stays the same one.
 * A key that can't be deleted or redefined (non-configurable) is left, as `Reflect` reports it.
 * @internal
 */
export function snapshotOwnProperties(target: object): () => void {
  const saved = new Map<string | symbol, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
    if (descriptor !== undefined) saved.set(key, descriptor)
  }
  return () => {
    for (const key of Reflect.ownKeys(target)) {
      if (!saved.has(key)) Reflect.deleteProperty(target, key)
    }
    for (const [key, descriptor] of saved) {
      const now = Reflect.getOwnPropertyDescriptor(target, key)
      if (now === undefined || differs(now, descriptor)) {
        Reflect.defineProperty(target, key, descriptor)
      }
    }
  }
}

/** Whether two descriptors of one key differ in a value, an accessor or a flag. */
function differs(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return (
    !Object.is(a.value, b.value) ||
    a.get !== b.get ||
    a.set !== b.set ||
    a.writable !== b.writable ||
    a.enumerable !== b.enumerable ||
    a.configurable !== b.configurable
  )
}
