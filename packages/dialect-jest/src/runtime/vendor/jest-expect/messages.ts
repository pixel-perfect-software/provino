/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// provino: the text expect/src/index.ts and jestMatchersObject.ts print for failures that are
// not a matcher's, as functions the engine calls. Each expression is Jest's, with the line it
// comes from.
import {getType} from '@jest/get-type';
import {matcherUtilsNamespace as matcherUtils} from './lazy-jest-packages.ts'; // provino: loaded on first use (T7.12), same package and version: see ./lazy-jest-packages.ts

type Call = {
  readonly matcherName: string;
  readonly isNot: boolean;
  readonly promise: string;
};

const hint = ({matcherName, isNot, promise}: Call): string =>
  matcherUtils.matcherHint(matcherName, undefined, '', {isNot, promise});

// index.ts L107
export const tooManyArguments = (): string =>
  'Expect takes at most one argument.';

// index.ts L161
export const noMessage = (): string =>
  matcherUtils.RECEIVED_COLOR('No message was specified for this matcher.');

// index.ts L430-L435
export const invalidResult = (result: unknown): string =>
  'Unexpected return from a matcher function.\n' +
  'Matcher functions should ' +
  'return an object in the following format:\n' +
  '  {message?: string | function, pass: boolean}\n' +
  `'${matcherUtils.stringify(result)}' was returned`;

// index.ts L182-L192 (and L238-L248, the same text for `.rejects`)
export const notAPromise = (call: Call, actual: unknown): string =>
  matcherUtils.matcherErrorMessage(
    hint(call),
    `${matcherUtils.RECEIVED_COLOR(
      'received',
    )} value must be a promise or a function returning a promise`,
    matcherUtils.printWithType('Received', actual, matcherUtils.printReceived),
  );

// index.ts L205-L213
export const rejectedInsteadOfResolved = (call: Call, error: unknown): string =>
  `${hint(call)}\n\n` +
  'Received promise rejected instead of resolved\n' +
  `Rejected to value: ${matcherUtils.printReceived(error)}`;

// index.ts L256-L264
export const resolvedInsteadOfRejected = (call: Call, result: unknown): string =>
  `${hint(call)}\n\n` +
  'Received promise resolved instead of rejected\n' +
  `Resolved to value: ${matcherUtils.printReceived(result)}`;

// jestMatchersObject.ts L65-L69 (the text at L66)
export const invalidMatcher = (key: string, matcher: unknown): string =>
  `expect.extend: \`${key}\` is not a valid matcher. Must be a function, is "${getType(
    matcher,
  )}"`;

// jestMatchersObject.ts L134-L138 (the text at L135)
export const invalidTesters = (newTesters: unknown): string =>
  `expect.customEqualityTesters: Must be set to an array of Testers. Was given "${getType(
    newTesters,
  )}"`;

// index.ts L451
export const ensureNoExpected = (expected: unknown, matcherName: string): void =>
  matcherUtils.ensureNoExpected(expected, matcherName);

// extractExpectedAssertionsErrors.ts L46-L56: `expect.assertions(expected)` and `actual` calls.
export const assertionCount = (expected: number, actual: number): string => {
  const numOfAssertionsExpected = matcherUtils.EXPECTED_COLOR(
    matcherUtils.pluralize('assertion', expected),
  );

  return (
    `${matcherUtils.matcherHint('.assertions', '', expected.toString(), {
      isDirectExpectCall: true,
    })}\n\n` +
    `Expected ${numOfAssertionsExpected} to be called but received ${matcherUtils.RECEIVED_COLOR(
      matcherUtils.pluralize('assertion call', actual || 0),
    )}.`
  );
};

// extractExpectedAssertionsErrors.ts L65-L73: `expect.hasAssertions()` and none were made.
export const noAssertions = (): string => {
  const expected = matcherUtils.EXPECTED_COLOR('at least one assertion');
  const received = matcherUtils.RECEIVED_COLOR('received none');

  return `${matcherUtils.matcherHint('.hasAssertions', '', '', {
    isDirectExpectCall: true,
  })}\n\nExpected ${expected} to be called but ${received}.`;
};
