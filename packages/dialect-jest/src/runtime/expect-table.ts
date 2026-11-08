// The Jest dialect's matcher table (T7.5): what `jestExpectPolicy.matcherTable` loads. The
// matchers, asymmetric matchers and messages are Jest 30.5.2's own, vendored in
// `vendor/jest-expect/` (see its UPSTREAM.md). Jest 30 removed the aliases (`toBeCalled`,
// `toThrowError`, …, #14632), so none is registered: calling one throws V8's
// `expect(...).toBeCalled is not a function`, as in Jest. The snapshot matchers come with T7.10.
import { iterableEquality, subsetEquality } from '@jest/expect-utils'
import type { ExpectTable } from '@provino/types'
import * as matcherUtils from 'jest-matcher-utils'
import * as policyMessages from './policy-messages.ts'
import {
  any,
  anything,
  arrayContaining,
  arrayNotContaining,
  arrayOf,
  closeTo,
  notArrayOf,
  notCloseTo,
  objectContaining,
  objectNotContaining,
  stringContaining,
  stringMatching,
  stringNotContaining,
  stringNotMatching,
} from './vendor/jest-expect/asymmetricMatchers.ts'
import { createCustomMatcher } from './vendor/jest-expect/customMatcher.ts'
import matchers from './vendor/jest-expect/matchers.ts'
import * as messages from './vendor/jest-expect/messages.ts'
import spyMatchers from './vendor/jest-expect/spyMatchers.ts'
import toThrowMatchers, {
  createMatcher as createThrowMatcher,
} from './vendor/jest-expect/toThrowMatchers.ts'
import type { RawMatcherFn } from './vendor/jest-expect/types.ts'

/**
 * Builds the Jest 30.5 matcher table. The worker loads it once, by `ModuleRef`, after the slot is
 * installed.
 * @public
 */
export function jestExpectTable(): ExpectTable {
  return {
    // The order Jest registers them in (`expect/src/index.ts` L459–L461).
    matchers: { ...matchers, ...spyMatchers, ...toThrowMatchers },
    // `getPromiseMatcher` (index.ts L92–L103): under `.resolves`/`.rejects`, `toThrow` reads the
    // settled value as the thrown one. It is a fresh function, so it isn't flagged internal.
    promiseMatchers: { toThrow: createThrowMatcher('toThrow', true) },
    asymmetric: {
      any,
      anything,
      arrayContaining,
      arrayOf,
      closeTo,
      objectContaining,
      stringContaining,
      stringMatching,
    },
    // `expect.not` (index.ts L406–L413).
    asymmetricNot: {
      arrayContaining: arrayNotContaining,
      arrayOf: notArrayOf,
      closeTo: notCloseTo,
      objectContaining: objectNotContaining,
      stringContaining: stringNotContaining,
      stringMatching: stringNotMatching,
    },
    // What `makeThrowingMatcher` gives matchers as `this.utils` (index.ts L284–L288).
    utils: { ...matcherUtils, iterableEquality, subsetEquality },
    // Jest's text, plus ours for the policies Jest lacks. No `unreachable`: Jest has no
    // `expect.unreachable`, and its absence here keeps it off `expect`.
    messages: { ...messages, ...policyMessages },
    customAsymmetric: (name, matcher) =>
      createCustomMatcher(name, matcher as unknown as RawMatcherFn),
  }
}
