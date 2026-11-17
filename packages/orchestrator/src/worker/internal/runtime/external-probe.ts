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
// file's fresh global. So with `writes` on, the window's open keeps every own key's descriptor
// (symbols too), and the close compares what the load left with it (`wroteGlobal`). The keys that
// count are exactly those `@provino/env-shared`'s `snapshotProperties.restore` (every
// environment's teardown) takes back: an added key it can delete (configurable, and no process
// singleton), and a changed key it can define back. An accessor that became a data key is a write
// unless the new value is Node's own: a native function, or what the old getter returns (Node's
// lazy globals, `fetch` and `WebSocket` among them, settle that way on their first read). A key the
// load deleted is not a write (the restore puts it back, and the shared copy never needed it), and
// neither is an assignment of the value a key already held (the restore leaves it as it is).
// **Limit:** an assignment through a get/set accessor whose value lives in a closure (`process`,
// `performance`) leaves the descriptor as it was, and the restore replays the old value; that is
// not seen, since reading those getters can run code (Node 26's `localStorage` warns).
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
  snapshot?: Map<string | symbol, PropertyDescriptor>,
): [string, PropertyDescriptor][] {
  const keys: [string, PropertyDescriptor][] = []
  // With a snapshot to fill, one walk over every own key serves both; the reads look at strings.
  const names =
    snapshot === undefined ? Object.getOwnPropertyNames(global) : Reflect.ownKeys(global)
  for (const key of names) {
    const descriptor = Reflect.getOwnPropertyDescriptor(global, key)
    if (descriptor === undefined) continue
    snapshot?.set(key, descriptor)
    if (typeof key !== 'string') continue
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
  if (!triggers.reads) {
    // Writes alone: the descriptors, and none of the reads' work (no baseline, no covered keys).
    if (!triggers.writes) return () => false
    const before = ownDescriptors(global)
    return () => wroteGlobal(global, before)
  }
  const snapshot = triggers.writes ? new Map<string | symbol, PropertyDescriptor>() : undefined
  const stopCovered = covered?.watch(note)
  const watched: Watched[] = []
  try {
    for (const [key, original] of perFileKeys(global, baseline, covered, snapshot)) {
      const { accessor, final } = watchingAccessor(original, note)
      Object.defineProperty(global, key, accessor)
      watched.push({ key, accessor, final })
    }
  } catch (error) {
    restoreWatched(global, watched)
    stopCovered?.()
    throw error
  }
  return () => {
    stopCovered?.()
    // What the load left, read before the watched keys go back: a key still holding the window's
    // accessor is what that accessor holds now (`final`), any other key is as the load left it.
    const wrote = snapshot !== undefined && wroteGlobal(global, snapshot, leftIn(watched))
    restoreWatched(global, watched)
    return touched || wrote
  }
}

/** Every own key of `global`, symbols too, with its descriptor. */
function ownDescriptors(global: object): Map<string | symbol, PropertyDescriptor> {
  const snapshot = new Map<string | symbol, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(global)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(global, key)
    if (descriptor !== undefined) snapshot.set(key, descriptor)
  }
  return snapshot
}

/** How a key's descriptor reads as the load left it (see `wroteGlobal`'s `left`). */
type LeftBy = (key: string | symbol, now: PropertyDescriptor) => PropertyDescriptor

const AS_IT_IS: LeftBy = (_key, now) => now

/** For the window's watched keys still holding their accessor, the descriptor they stand for. */
function leftIn(watched: readonly Watched[]): LeftBy {
  if (watched.length === 0) return AS_IT_IS
  const byKey = new Map(watched.map((entry) => [entry.key, entry] as const))
  return (key, now) => {
    const entry = typeof key === 'string' ? byKey.get(key) : undefined
    return entry !== undefined && now.get === entry.accessor.get ? entry.final() : now
  }
}

/**
 * Whether the load wrote a key the environment's restore will take back (see the header): an
 * added key the restore deletes, or a changed one it can define back. `left` reads a key's current
 * descriptor as the load left it (the window's own accessors stand for another).
 */
export function wroteGlobal(
  global: object,
  before: ReadonlyMap<string | symbol, PropertyDescriptor>,
  left: LeftBy = AS_IT_IS,
): boolean {
  for (const key of Reflect.ownKeys(global)) {
    const current = Reflect.getOwnPropertyDescriptor(global, key)
    if (current === undefined) continue
    const now = left(key, current)
    const previous = before.get(key)
    if (previous === undefined) {
      // The restore deletes it, unless it can't (not configurable) or keeps it (a singleton).
      if (now.configurable === true && !isProcessSingleton(key)) return true
      continue
    }
    if (changedBy(previous, now, global, key) && restorable(previous, now)) return true
  }
  return false
}

/**
 * Whether `now` is another write's than `previous`. An equal value is none (`Object.is`): the
 * restore leaves an unchanged descriptor alone, so a re-assertion breaks nothing. An accessor that
 * became a data key is a write unless the value is Node's own: a native function, or what the old
 * getter gives (a lazy global settling on its first read).
 */
function changedBy(
  previous: PropertyDescriptor,
  now: PropertyDescriptor,
  global: object,
  key: string | symbol,
): boolean {
  if ('value' in previous) return !('value' in now) || !Object.is(previous.value, now.value)
  if (!('value' in now)) return now.get !== previous.get
  if (isNativeFunction(now.value)) return false
  try {
    return !Object.is(previous.get?.call(global), now.value)
  } catch {
    return true
  } finally {
    // A lazy getter settles itself again as it is read; the load's value is what stays.
    Reflect.defineProperty(global, key, now)
  }
}

function isNativeFunction(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    Function.prototype.toString.call(value).endsWith('{ [native code] }')
  )
}

/**
 * Whether `snapshotProperties.restore` can define `previous` back over `now`: always over a
 * configurable key, and over a non-configurable one only as a new value of a writable data key.
 */
function restorable(previous: PropertyDescriptor, now: PropertyDescriptor): boolean {
  if (now.configurable === true) return true
  return (
    'value' in now &&
    'value' in previous &&
    now.writable === true &&
    previous.configurable !== true &&
    previous.writable === true &&
    now.enumerable === previous.enumerable
  )
}

/**
 * `@provino/env-shared`'s `isProcessSingleton` (`restore.ts`), copied: the worker node may not
 * import an environment package. Symbols a package defines once per process, which the restore
 * leaves in place.
 */
function isProcessSingleton(key: string | symbol): boolean {
  return typeof key === 'symbol' && /^(graceful-fs\.queue|undici\.)/.test(key.description ?? '')
}

function restoreWatched(global: object, watched: readonly Watched[]): void {
  for (const { key, accessor, final } of watched) {
    const now = Object.getOwnPropertyDescriptor(global, key)
    // The load redefined or deleted the key itself: that is its value now.
    if (now?.get === accessor.get) Object.defineProperty(global, key, final())
  }
}
