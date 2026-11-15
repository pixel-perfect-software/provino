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
// An accessor whose getter is the baseline's is unchanged, whatever its setter: the per-file
// snapshot every environment takes wraps the setters of the worker's own accessors.
//
// The keys an environment populated from its window (several hundred under jsdom) are accessors
// already: when the environment offers `globalReads`, the probe listens to them instead of
// redefining each one per window, which is what made a jsdom worker's first file pay hundreds of
// `defineProperty` calls per external.
//
// @internal
import type { GlobalReadWatch } from '@provino/types'

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

/**
 * Whether a key still holds what the worker booted with. An accessor is compared by its getter
 * alone: every environment's per-file snapshot wraps the setter of each get/set accessor (Node's
 * `Buffer` and `performance`, and Node 26's `localStorage`) to record an assignment, which puts
 * nothing per file on the global. Counting it would learn every package that reads `performance`
 * at load (lru-cache does) for nothing, and on any runtime whose own accessors differ.
 */
function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return 'value' in a ? 'value' in b && Object.is(a.value, b.value) : a.get === b.get
}

/**
 * The keys of `global` a file's setup installed or changed: every own string key whose descriptor
 * is not the baseline's, that the window can turn into an accessor and back (configurable), and
 * that the environment's own accessors don't already report (`covered`). A non-configurable key
 * can't be watched: it is left as it is, and a read of it goes unnoticed.
 */
export function perFileKeys(
  global: object,
  baseline: GlobalBaseline,
  covered?: GlobalReadWatch,
): [string, PropertyDescriptor][] {
  const keys: [string, PropertyDescriptor][] = []
  for (const key of Object.getOwnPropertyNames(global)) {
    if (UNWATCHED.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(global, key)
    if (descriptor === undefined || descriptor.configurable !== true) continue
    if (covered?.covers(key, descriptor) === true) continue
    const base = baseline.get(key)
    if (base !== undefined && sameDescriptor(base, descriptor)) continue
    keys.push([key, descriptor])
  }
  return keys
}

/** The accessor that stands for `original` while the window is open, noting each read in `note`. */
function watchingAccessor(
  original: PropertyDescriptor,
  note: () => void,
): { readonly accessor: PropertyDescriptor; readonly value: () => unknown } {
  const enumerable = original.enumerable === true
  const { get, set } = original
  if (get !== undefined || set !== undefined) {
    // An accessor forwards both ways, and has a setter only if the original had one.
    const accessor: PropertyDescriptor = {
      configurable: true,
      enumerable,
      get(this: unknown) {
        note()
        return get?.call(this)
      },
      ...(set === undefined
        ? {}
        : {
            set(this: unknown, next: unknown) {
              note()
              set.call(this, next)
            },
          }),
    }
    return { accessor, value: () => undefined }
  }
  let value: unknown = original.value
  // A read-only data key gets no setter, so a write still throws in strict code.
  const accessor: PropertyDescriptor = {
    configurable: true,
    enumerable,
    get() {
      note()
      return value
    },
    ...(original.writable === true
      ? {
          set(next: unknown) {
            note()
            value = next
          },
        }
      : {}),
  }
  return { accessor, value: () => value }
}

/**
 * Turns each per-file key of `global` into an accessor that notes a read, for as long as one
 * external's first load runs, and listens to the environment's own accessors (`covered`) instead
 * of redefining theirs. Returns the call that puts every key back and says whether one was read
 * (or written: a package that sets a per-file global binds the file's too). An accessor and a
 * read-only data key get their exact descriptor back; a writable data key gets its descriptor
 * with the value it holds now.
 */
export function watchPerFileGlobals(
  global: object,
  baseline: GlobalBaseline,
  covered?: GlobalReadWatch,
): () => boolean {
  let touched = false
  const note = (): void => {
    touched = true
  }
  const stopCovered = covered?.watch(note)
  const watched: {
    readonly key: string
    readonly original: PropertyDescriptor
    readonly accessor: PropertyDescriptor
    readonly value: () => unknown
  }[] = []
  try {
    for (const [key, original] of perFileKeys(global, baseline, covered)) {
      const { accessor, value } = watchingAccessor(original, note)
      Object.defineProperty(global, key, accessor)
      watched.push({ key, original, accessor, value })
    }
  } catch (error) {
    restoreWatched(global, watched)
    stopCovered?.()
    throw error
  }
  return () => {
    stopCovered?.()
    restoreWatched(global, watched)
    return touched
  }
}

function restoreWatched(
  global: object,
  watched: readonly {
    readonly key: string
    readonly original: PropertyDescriptor
    readonly accessor: PropertyDescriptor
    readonly value: () => unknown
  }[],
): void {
  for (const { key, original, accessor, value } of watched) {
    const now = Object.getOwnPropertyDescriptor(global, key)
    // The load redefined or deleted the key itself: that is its value now.
    if (now === undefined || now.get !== accessor.get) continue
    Object.defineProperty(
      global,
      key,
      'value' in original && original.writable === true
        ? { ...original, value: value() }
        : original,
    )
  }
}
