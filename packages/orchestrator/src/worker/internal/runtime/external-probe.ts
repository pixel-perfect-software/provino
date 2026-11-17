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
// Writes (B23f, `ModulePolicy.reevaluatePatchingExternals`): a load that adds a key to the global
// or replaces one (`globalThis.__MSW_INTERNAL_CONNECTION_CONTEXT ??= …`, `globalThis.atob = …`)
// counts too. The environment's restore takes the key away after the file, and the shared copy
// never writes it again, where Jest's evaluation in each file's registry writes it on every
// file's fresh global. So with `writes` on, the walk at the window's open (the one `perFileKeys`
// makes anyway) keeps every own string key's descriptor, and the close walks the keys again: a key
// that is new, a data key whose value is another, or a key whose kind or getter changed is a
// write. An accessor that became a data key is not: that is how Node's lazy globals
// (`WebSocket`, `navigator`, …) settle on their first read. A key the load deleted is not either.
//
// @internal
import type { GlobalReadWatch } from '@provino/types'

/**
 * The global's own string keys and their descriptors, read once when the worker boots, with what
 * a worker-wide setup step installed taken in since (`adoptingGlobals`).
 */
export type GlobalBaseline = Map<string, PropertyDescriptor>

/** Keys never watched: see the header. */
const UNWATCHED: ReadonlySet<string> = new Set(['process'])

/** The global's own string keys as the worker found them: what no file's setup has touched. */
export function readGlobalBaseline(global: object = globalThis): GlobalBaseline {
  const baseline: GlobalBaseline = new Map()
  for (const key of Object.getOwnPropertyNames(global)) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key)
    if (descriptor !== undefined) baseline.set(key, descriptor)
  }
  return baseline
}

/**
 * Runs a step the worker takes once, before any file (an environment's `prepare`, a dialect's
 * boot factory), and takes what it changed on the global into `baseline`: it is the same in every
 * file, so it is no per-file global (a wrapper an environment's `prepare` puts on a timer
 * function, which a shared package captures as it loads). A key it removed leaves the baseline
 * too. With no baseline (the policy doesn't watch external loads) the step just runs.
 */
export async function adoptingGlobals<T>(
  baseline: GlobalBaseline | undefined,
  step: () => T | Promise<T>,
  global: object = globalThis,
): Promise<T> {
  if (baseline === undefined) return await step()
  const before = readGlobalBaseline(global)
  const result = await step()
  const now = readGlobalBaseline(global)
  for (const [key, descriptor] of now) {
    const previous = before.get(key)
    if (previous === undefined || !sameDescriptor(previous, descriptor)) {
      baseline.set(key, descriptor)
    }
  }
  for (const key of before.keys()) {
    if (!now.has(key)) baseline.delete(key)
  }
  return result
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
  snapshot?: Map<string, PropertyDescriptor>,
): [string, PropertyDescriptor][] {
  const keys: [string, PropertyDescriptor][] = []
  for (const key of Object.getOwnPropertyNames(global)) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key)
    if (descriptor === undefined) continue
    snapshot?.set(key, descriptor)
    if (UNWATCHED.has(key) || descriptor.configurable !== true) continue
    if (covered?.covers(key, descriptor) === true) continue
    const base = baseline.get(key)
    if (base !== undefined && sameDescriptor(base, descriptor)) continue
    keys.push([key, descriptor])
  }
  return keys
}

/** A key turned into an accessor for the window: the accessor, and the descriptor to put back. */
interface Watched {
  readonly key: string
  readonly accessor: PropertyDescriptor
  /** The descriptor the key gets when the window closes (a writable data key's holds its value then). */
  readonly final: () => PropertyDescriptor
}

/** The accessor that stands for `original` while the window is open, noting each read in `note`. */
function watchingAccessor(
  original: PropertyDescriptor,
  note: () => void,
): Pick<Watched, 'accessor' | 'final'> {
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
    return { accessor, final: () => original }
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
  return { accessor, final: () => (original.writable === true ? { ...original, value } : original) }
}

/** What a window counts: a read of a per-file global (D127, D129), a write to the global (B23f). */
export interface ProbeTriggers {
  /** `ModulePolicy.reevaluateHookingExternals`: a read or write of a per-file key. */
  readonly reads: boolean
  /** `ModulePolicy.reevaluatePatchingExternals`: a key the load added or replaced. */
  readonly writes: boolean
}

const READS_ONLY: ProbeTriggers = { reads: true, writes: false }

/**
 * Turns each per-file key of `global` into an accessor that notes a read, for as long as one
 * external's first load runs, and listens to the environment's own accessors (`covered`) instead
 * of redefining theirs. Returns the call that puts every key back and says whether one was read
 * (or written: a package that sets a per-file global binds the file's too). An accessor and a
 * read-only data key get their exact descriptor back; a writable data key gets its descriptor
 * with the value it holds now. With `triggers.writes`, the call also says whether the load added
 * or replaced a key of the global (see the header); with `triggers.reads` off, no key is redefined
 * and no read is heard.
 */
export function watchPerFileGlobals(
  global: object,
  baseline: GlobalBaseline,
  covered?: GlobalReadWatch,
  triggers: ProbeTriggers = READS_ONLY,
): () => boolean {
  let touched = false
  const note = (): void => {
    touched = true
  }
  const snapshot = triggers.writes ? new Map<string, PropertyDescriptor>() : undefined
  const stopCovered = triggers.reads ? covered?.watch(note) : undefined
  const watched: Watched[] = []
  try {
    const keys = perFileKeys(global, baseline, covered, snapshot)
    if (triggers.reads) {
      for (const [key, original] of keys) {
        const { accessor, final } = watchingAccessor(original, note)
        Object.defineProperty(global, key, accessor)
        watched.push({ key, accessor, final })
      }
    }
  } catch (error) {
    restoreWatched(global, watched)
    stopCovered?.()
    throw error
  }
  return () => {
    stopCovered?.()
    restoreWatched(global, watched)
    return touched || (snapshot !== undefined && wroteGlobal(global, snapshot))
  }
}

/**
 * Whether `global` has a key `before` lacks, or one whose descriptor is another write's: a data
 * key with another value, a data key made an accessor, an accessor with another getter. An
 * accessor made a data key is a lazy global settling on its first read, not a write.
 */
export function wroteGlobal(
  global: object,
  before: ReadonlyMap<string, PropertyDescriptor>,
): boolean {
  for (const key of Object.getOwnPropertyNames(global)) {
    const previous = before.get(key)
    if (previous === undefined) return true
    const now = Object.getOwnPropertyDescriptor(global, key)
    if (now === undefined) continue
    if ('value' in previous) {
      if (!('value' in now) || !Object.is(previous.value, now.value)) return true
    } else if ('get' in now && now.get !== previous.get) {
      return true
    }
  }
  return false
}

function restoreWatched(global: object, watched: readonly Watched[]): void {
  for (const { key, accessor, final } of watched) {
    const now = Object.getOwnPropertyDescriptor(global, key)
    // The load redefined or deleted the key itself: that is its value now.
    if (now?.get === accessor.get) Object.defineProperty(global, key, final())
  }
}
