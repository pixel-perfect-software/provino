// Reading the slot without owning it: the asymmetric base works under whichever engine installed
// the slot (ours, or Jest's own `expect` in an interop realm).
import { MATCHERS_SLOT, type MatchersSlot } from '../slot.ts'

/**
 * The slot in this realm, whoever installed it; any field may be missing (Jest's has no `utils`).
 * @internal
 */
export function readSlot(): Partial<MatchersSlot> {
  const slot: unknown = Reflect.get(globalThis, MATCHERS_SLOT)
  return typeof slot === 'object' && slot !== null ? (slot as Partial<MatchersSlot>) : {}
}
