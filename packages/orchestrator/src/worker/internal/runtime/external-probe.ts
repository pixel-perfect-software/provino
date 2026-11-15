// D127 / P42: the worker's watcher for a shared external's first native load (the loader's
// `watchExternalLoads`, under `ModulePolicy.reevaluateHookingExternals`). It answers whether the
// load read a per-file global: one the running file's setup put on the global, which is what a
// package captures to be the file's own (a test hook, `jest`, `expect`, the environment's
// `document` and `window`).
//
// Which globals those are is not a list of names: it is every own string key of the global whose
// descriptor differs from the one the worker booted with, as the file's environment (its
// populated window, its per-file restore) and the dialect's globals left it, minus `process` (a
// per-file copy that nearly every package reads for `NODE_ENV`: counting it would make every
// package that loads per file, which is Jest's cost and not the read the trigger is about). While
// the window is open each one is an accessor that notes a read and forwards to the real value;
// when it closes, the original descriptor is put back, so no getter is left on `document` and the
// steady state pays nothing. A key the load redefined itself is left as the load left it.
//
// @internal

/** The global's own string keys and their descriptors, read once when the worker boots. */
export type GlobalBaseline = ReadonlyMap<string, PropertyDescriptor>

/** Keys never watched: see the header. */
const UNWATCHED: ReadonlySet<string> = new Set(['process'])

/** The global's own string keys as the worker found them: what no file's setup has touched. */
export function readGlobalBaseline(global: object = globalThis): GlobalBaseline {
  const baseline = new Map<string, PropertyDescriptor>()
  for (const key of Object.getOwnPropertyNames(global)) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key)
    if (descriptor !== undefined) baseline.set(key, descriptor)
  }
  return baseline
}

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return 'value' in a
    ? 'value' in b && Object.is(a.value, b.value)
    : a.get === b.get && a.set === b.set
}

/**
 * The keys of `global` a file's setup installed or changed: every own string key whose descriptor
 * is not the baseline's, that the window can turn into an accessor and back (configurable).
 */
export function perFileKeys(
  global: object,
  baseline: GlobalBaseline,
): [string, PropertyDescriptor][] {
  const keys: [string, PropertyDescriptor][] = []
  for (const key of Object.getOwnPropertyNames(global)) {
    if (UNWATCHED.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(global, key)
    if (descriptor === undefined || descriptor.configurable !== true) continue
    const base = baseline.get(key)
    if (base === undefined || !sameDescriptor(base, descriptor)) keys.push([key, descriptor])
  }
  return keys
}

/**
 * Turns each per-file key of `global` into an accessor that notes a read, for as long as one
 * external's first load runs. Returns the call that puts every key back and says whether one was
 * read (or written: a package that sets a per-file global binds the file's too).
 */
export function watchPerFileGlobals(global: object, baseline: GlobalBaseline): () => boolean {
  let touched = false
  const watched = perFileKeys(global, baseline).map(([key, original]) => {
    let value: unknown = original.value
    const accessor: PropertyDescriptor = {
      configurable: true,
      enumerable: original.enumerable === true,
      get(this: unknown) {
        touched = true
        return original.get === undefined ? value : original.get.call(this)
      },
      set(this: unknown, next: unknown) {
        touched = true
        if (original.set !== undefined) original.set.call(this, next)
        else if (original.get === undefined) value = next
      },
    }
    Object.defineProperty(global, key, accessor)
    return { key, original, accessor, value: () => value }
  })
  return () => {
    for (const { key, original, accessor, value } of watched) {
      const now = Object.getOwnPropertyDescriptor(global, key)
      // The load redefined or deleted the key itself: that is its value now.
      if (now === undefined || now.get !== accessor.get) continue
      Object.defineProperty(
        global,
        key,
        original.get === undefined && original.set === undefined
          ? { ...original, value: value() }
          : original,
      )
    }
    return touched
  }
}
