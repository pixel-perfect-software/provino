// @provino/expect: the neutral expect engine (Track 7 R1). The dialect supplies the matchers,
// the asymmetric matchers, `this.utils` and every message through an `ExpectTable`.
export { AsymmetricMatcher } from './asymmetric.ts'
export type { MatcherContext } from './context.ts'
export { ExpectError, type ExpectErrorCode } from './errors.ts'
export { type CreateExpectOptions, createExpect, MatcherResultError } from './expect.ts'
export {
  createMatcherRegistry,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatcherRegistry,
  type MatchersSlot,
  type SlotHandle,
} from './slot.ts'
export { createStateSource, type StateSource, type StateSourceOptions } from './state.ts'
