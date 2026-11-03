// Provino's stand-in for Jest's `expect/src/jestMatchersObject.ts` (not vendored). Jest's module
// creates `globalThis[Symbol.for('$$jest-matchers-object')]` when it loads, if nothing has; here
// `@provino/expect` owns the slot (T7.2) and installs it before any matcher module loads, so this
// file only reads it, and only when a matcher runs. The exports keep Jest's names so the vendored
// files import them unchanged.
import type {Tester} from '@jest/expect-utils';
import type {MatcherState} from './types.ts';

const JEST_MATCHERS_OBJECT = Symbol.for('$$jest-matchers-object');

/** Jest's flag for built-in matchers (the engine keeps its own record; the symbol is shared). */
export const INTERNAL_MATCHER_FLAG: unique symbol = Symbol.for(
  '$$jest-internal-matcher',
);

interface Slot {
  readonly state: MatcherState;
  readonly customEqualityTesters: Array<Tester>;
}

const EMPTY: Slot = {
  customEqualityTesters: [],
  state: {
    assertionCalls: 0,
    expectedAssertionsNumber: null,
    isExpectingAssertions: false,
    numPassingAsserts: 0,
    suppressedErrors: [],
  },
};

/** The realm's slot, or empty state when none is installed. */
const slot = (): Slot =>
  (Reflect.get(globalThis, JEST_MATCHERS_OBJECT) as Slot | undefined) ?? EMPTY;

export const getState = <State extends MatcherState = MatcherState>(): State =>
  slot().state as State;

export const getCustomEqualityTesters = (): Array<Tester> =>
  slot().customEqualityTesters;
