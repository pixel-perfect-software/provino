import type { ExpectStatic, MatcherState } from './types.ts'
import { JEST_MATCHERS_OBJECT } from './constants.ts'

// provino: `@provino/expect` owns the matcher slot (`Symbol.for('$$jest-matchers-object')`) and the
// state of the running test attempt, so nothing is defined on `globalThis` here, and the state is
// read through the slot rather than from a map keyed by an `expect` instance. Upstream's module
// body (the three global accessors) is left out.

export function getState<State extends MatcherState = MatcherState>(_expect?: ExpectStatic): State {
  return (globalThis as any)[JEST_MATCHERS_OBJECT].state
}

export function setState<State extends MatcherState = MatcherState>(
  state: Partial<State>,
  _expect?: ExpectStatic,
): void {
  // so it keeps getters from `testPath`
  Object.defineProperties(getState(), Object.getOwnPropertyDescriptors(state))
}
