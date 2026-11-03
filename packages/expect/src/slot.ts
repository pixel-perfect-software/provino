// The global matcher slot (T7.2, Track 7 R1 and §Module boundaries). Jest's matchers, and the
// third-party code written against them (jest-extended, jest-image-snapshot, a user-loaded
// `expect`), find matchers, equality testers and the current state through
// `globalThis[Symbol.for('$$jest-matchers-object')]`. The engine installs it first, as the only
// writer, and its `state` reads the current test's state. Jest's own `expect` defines the slot
// non-configurable; ours is configurable, so a realm teardown can drop it.
import type { EqualityTester, Matcher, MatcherState } from '@provino/types'
import { ExpectError } from './errors.ts'
import type { StateSource } from './state.ts'

/**
 * The slot's key. Both runners use it (Track 7 F3).
 * @public
 */
export const MATCHERS_SLOT: unique symbol = Symbol.for('$$jest-matchers-object')

/**
 * The matchers, equality testers and matcher `utils` of one `expect`. The slot exposes the same
 * objects, so `expect.extend` and code that reads the slot always agree.
 * @public
 */
export interface MatcherRegistry {
  readonly matchers: Record<string, Matcher>
  readonly customEqualityTesters: EqualityTester[]
  /** `this.utils`; the dialect's table sets it when `createExpect` runs. */
  utils: object
}

/**
 * An empty registry, made before the slot so the slot exists before any matcher module loads.
 * @public
 */
export function createMatcherRegistry(): MatcherRegistry {
  return { matchers: Object.create(null), customEqualityTesters: [], utils: {} }
}

/**
 * The installed slot.
 * @public
 */
export interface SlotHandle {
  /** Removes the slot, if it is still this one. */
  uninstall(): void
}

/**
 * What the slot holds, as third-party code reads it.
 * @public
 */
export interface MatchersSlot {
  readonly matchers: Record<string, Matcher>
  readonly customEqualityTesters: EqualityTester[]
  readonly state: MatcherState
  /**
   * `this.utils`, for the asymmetric base. Ours only, and not enumerable, so the slot's own keys
   * stay Jest's three.
   */
  readonly utils?: object
}

/**
 * Installs the slot on `globalThis`. Throws `EXPECT_SLOT_TAKEN` if another one is there: a
 * non-configurable one means Jest's `expect` loaded first in this realm, which the worker must
 * prevent (the slot comes before any matcher module).
 * @public
 */
export function installMatchersSlot(source: StateSource, registry: MatcherRegistry): SlotHandle {
  if (Object.hasOwn(globalThis, MATCHERS_SLOT)) {
    throw new ExpectError(
      'EXPECT_SLOT_TAKEN',
      'globalThis[Symbol.for("$$jest-matchers-object")] is already defined: install the slot before any expect or matcher module loads',
    )
  }
  const slot: MatchersSlot = {
    matchers: registry.matchers,
    customEqualityTesters: registry.customEqualityTesters,
    get state(): MatcherState {
      return source.current()
    },
  }
  // A getter: `createExpect` sets the registry's `utils` after the slot is installed.
  Object.defineProperty(slot, 'utils', { get: () => registry.utils })
  Object.defineProperty(globalThis, MATCHERS_SLOT, { value: slot, configurable: true })
  return {
    uninstall(): void {
      if (Reflect.get(globalThis, MATCHERS_SLOT) === slot)
        Reflect.deleteProperty(globalThis, MATCHERS_SLOT)
    },
  }
}
