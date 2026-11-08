// @provino/expect: the neutral expect engine (Track 7 R1). The dialect supplies the matchers,
// the asymmetric matchers, `this.utils` and every message through an `ExpectTable`.
export { AsymmetricMatcher } from './asymmetric.ts'
export type { MatcherContext } from './context.ts'
export {
  createEndOfTest,
  type EndOfTest,
  type EndOfTestAttempt,
  type EndOfTestOptions,
} from './end-of-test.ts'
export { ExpectError, type ExpectErrorCode } from './errors.ts'
export {
  type CreateExpectOptions,
  createExpect,
  MatcherResultError,
  type UnawaitedAssertion,
} from './expect.ts'
export type { PollTimers } from './poll.ts'
export {
  createMatcherRegistry,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatcherRegistry,
  type MatchersSlot,
  type RegistrySnapshot,
  type SlotHandle,
  snapshotRegistry,
} from './slot.ts'
export {
  createStateSource,
  type StateSource,
  type StateSourceOptions,
  type TestRun,
} from './state.ts'
