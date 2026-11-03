/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// provino: the asymmetric form `expect.extend` registers, extracted from `setMatchers` in
// expect/src/jestMatchersObject.ts (L79-L107) so the engine can build it for any custom matcher.
// As in Jest, the class is made once per registration (here, per call of `createCustomMatcher`)
// and every instance shares it; the class body is unchanged.
import {AsymmetricMatcher} from './asymmetricMatchers.ts'; // provino: .ts extension (Node ESM)
import type {RawMatcherFn, SyncExpectationResult} from './types.ts'; // provino: .ts extension (Node ESM)

export const createCustomMatcher = (
  key: string,
  matcher: RawMatcherFn,
): ((
  inverse: boolean,
  sample: ReadonlyArray<unknown>,
) => AsymmetricMatcher<[unknown, ...Array<unknown>]>) => {
  class CustomMatcher extends AsymmetricMatcher<[unknown, ...Array<unknown>]> {
    constructor(inverse = false, ...sample: [unknown, ...Array<unknown>]) {
      super(sample, inverse);
    }

    asymmetricMatch(other: unknown) {
      const {pass} = matcher.call(
        this.getMatcherContext(),
        other,
        ...this.sample,
      ) as SyncExpectationResult;

      return this.inverse ? !pass : pass;
    }

    toString() {
      return `${this.inverse ? 'not.' : ''}${key}`;
    }

    override getExpectedType() {
      return 'any';
    }

    override toAsymmetricMatcher() {
      return `${this.toString()}<${this.sample.map(String).join(', ')}>`;
    }
  }

  return (inverse, sample) =>
    new CustomMatcher(inverse, ...(sample as [unknown, ...Array<unknown>]));
};
