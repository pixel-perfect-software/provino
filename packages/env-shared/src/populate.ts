// T8.2: `populateGlobal` and its restore. The semantics are Vitest 5.0.5's `populateGlobal`
// (`packages/vitest/src/integrations/env/utils.ts`), kept line for line where they decide what a
// test sees: which keys are copied, write-through accessors with an override map, bound
// functions, `window`/`self`/`top`/`parent` as the global, `document.defaultView`. Two changes
// make the restore exact: descriptors are captured (as Vitest does for the keys it overrides)
// for every key it touches, `window` and its three siblings included, and `restore` puts back
// exactly those and deletes the rest.
import { KEYS } from './vendor/vitest/jsdom-keys.ts'

const SKIP_KEYS: readonly string[] = ['window', 'self', 'top', 'parent']
/** The vendored keys as a set: `windowKeys` tests membership for every key of a window. */
const VENDORED_KEYS: ReadonlySet<string> = new Set(KEYS)

/**
 * @public
 */
export interface PopulateOptions {
  /**
   * Bind the window's functions to the window: happy-dom's `addEventListener` and others rely on
   * `this`, and jsdom prefers the implementation behind symbols the global doesn't have.
   */
  readonly bindFunctions?: boolean
  /** Keys to copy besides the window's own names and the built-in list. */
  readonly additionalKeys?: readonly string[]
  /**
   * Make `window`, `self`, `top`, `parent` and `document.defaultView` the global (default `true`).
   * Off for an environment that isn't a window (Node's, the edge runtime's): its code must not
   * see a `window`.
   */
  readonly selfReferences?: boolean
}

/**
 * What `populateGlobal` did, and the means to undo it.
 * @public
 */
export interface Populated {
  /** Every key defined on the global, the four self-references included. */
  readonly keys: ReadonlySet<string>
  /** The descriptors the global held for a key before, by key. */
  readonly originals: ReadonlyMap<string | symbol, PropertyDescriptor>
  /**
   * Deletes every key populated and defines each original descriptor again. The global's own
   * names and every descriptor are as they were (key order aside: V8 keeps insertion order, so a
   * key that was deleted and redefined moves to the end).
   */
  restore(): void
}

function isClassLikeName(name: string): boolean {
  return name[0] === name[0]?.toUpperCase()
}

type Loose = Record<string | symbol, unknown>

/** The keys to copy: the built-in and additional lists plus the window's own names. */
function windowKeys(
  global: Loose,
  win: Loose,
  additionalKeys: readonly string[],
): ReadonlySet<string> {
  const additional = new Set(additionalKeys)
  const keys = new Set<string>()
  for (const key of [...additional, ...KEYS, ...Object.getOwnPropertyNames(win)]) {
    if (SKIP_KEYS.includes(key)) continue
    if (key in global) {
      if (additional.has(key) || VENDORED_KEYS.has(key)) keys.add(key)
      continue
    }
    keys.add(key)
  }
  return keys
}

/**
 * Defines the window's properties on `global` as write-through accessors and makes the global
 * stand in for the window. Returns what is needed to put the global back.
 * @public
 */
export function populateGlobal(
  global: object,
  win: object,
  options: PopulateOptions = {},
): Populated {
  const target = global as Loose
  const source = win as Loose
  const { bindFunctions = false, selfReferences = true } = options
  const keys = new Set(windowKeys(target, source, options.additionalKeys ?? []))
  const originals = new Map<string | symbol, PropertyDescriptor>()
  const overrides = new Map<string | symbol, unknown>()

  const capture = (key: string): void => {
    if (!Object.hasOwn(target, key)) return
    // The descriptor, not the value: reading a native lazy getter such as Node's `localStorage`
    // can warn.
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (descriptor !== undefined) originals.set(key, descriptor)
  }

  for (const key of keys) {
    const member = source[key]
    const bound =
      bindFunctions && typeof member === 'function' && !isClassLikeName(key)
        ? (member as (...args: unknown[]) => unknown).bind(win)
        : undefined
    // Vitest captures only a listed key that exists; every own key about to be redefined is the
    // same for those and exact for the rest.
    capture(key)
    Object.defineProperty(target, key, {
      get() {
        if (overrides.has(key)) return overrides.get(key)
        if (bound !== undefined) return bound
        return source[key]
      },
      set(value: unknown) {
        overrides.set(key, value)
        // Propagate to the window, which can change how its other APIs behave
        // (`innerWidth` and `matchMedia`).
        source[key] = value
      },
      configurable: true,
    })
  }

  if (selfReferences) {
    for (const key of [...SKIP_KEYS, 'global']) {
      if (key === 'global' && !('global' in target)) continue
      capture(key)
    }
    target.window = target
    target.self = target
    target.top = target
    target.parent = target
    if (target.global !== undefined) target.global = target

    // `document.defaultView` must be the same global context. The document belongs to the window,
    // which is closed afterwards, so it needs no restore.
    const document = target.document as object | undefined
    if (document !== undefined && (document as { defaultView?: unknown }).defaultView) {
      Object.defineProperty(document, 'defaultView', {
        get: () => target,
        enumerable: true,
        configurable: true,
      })
    }

    for (const key of SKIP_KEYS) keys.add(key)
  }

  return {
    keys,
    originals,
    restore() {
      for (const key of keys) delete target[key]
      for (const [key, descriptor] of originals) Object.defineProperty(target, key, descriptor)
    },
  }
}
