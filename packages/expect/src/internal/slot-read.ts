// Reading the slot without owning it: the asymmetric base works under whichever engine installed
// the slot (ours, or Jest's own `expect` in an interop realm).
import type { EqualityTester, MatcherState } from '@provino/types'

/**
 * Where our slot keeps its registry, for the asymmetric base's `utils`.
 * @internal
 */
export const REGISTRY: unique symbol = Symbol.for('provino.expect.registry')

/**
 * The slot's fields as both runners shape them; any may be missing.
 * @internal
 */
export interface SlotView {
  readonly state?: MatcherState
  readonly customEqualityTesters?: readonly EqualityTester[]
  /** Only our slot has it. */
  readonly utils?: object
}

/**
 * The slot in this realm, whoever installed it.
 * @internal
 */
export function readSlot(): SlotView {
  const slot: unknown = Reflect.get(globalThis, Symbol.for('$$jest-matchers-object'))
  if (typeof slot !== 'object' || slot === null) return {}
  const registry: unknown = Reflect.get(slot, REGISTRY)
  const utils: unknown =
    typeof registry === 'object' && registry !== null ? Reflect.get(registry, 'utils') : undefined
  return {
    ...(slot as Omit<SlotView, 'utils'>),
    ...(typeof utils === 'object' && utils !== null ? { utils } : {}),
  }
}
