/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {AssertionError} from 'node:assert'; // provino: the class loads on first use (`isAssertionError`), not when every Jest worker boots
import process from 'node:process';
import {
  DIM_COLOR,
  EXPECTED_COLOR,
  RECEIVED_COLOR,
  RESET,
  diff,
  printExpected,
  printReceived,
} from '../jest-expect/lazy-jest-packages.ts'; // provino: chalk's colours and jest-matcher-utils load on first use (T7.12), same packages and versions: see ../jest-expect/lazy-jest-packages.ts

// provino: jest-circus's `Circus.TestError` and `DiffOptions` are not dependencies here; the error is read as `unknown`.
interface AssertionErrorWithStack extends AssertionError {
  stack: string;
}

const assertOperatorsMap: Record<string, string> = {
  '!=': 'notEqual',
  '!==': 'notStrictEqual',
  '==': 'equal',
  '===': 'strictEqual',
};

const humanReadableOperators: Record<string, string> = {
  deepEqual: 'to deeply equal',
  deepStrictEqual: 'to deeply and strictly equal',
  equal: 'to be equal',
  notDeepEqual: 'not to deeply equal',
  notDeepStrictEqual: 'not to deeply and strictly equal',
  notEqual: 'to not be equal',
  notStrictEqual: 'not be strictly equal',
  strictEqual: 'to strictly be equal',
};

// provino: jest-circus maps every error of a finished test (`test_done`); the runtime hands each
// error here as it serializes it and takes the result in its place. `expand` is `state.expand`.
// circus formats a thrown value only when it has a stack: one with none is swapped for circus's own
// `asyncError`, an ordinary Error, which is left as it is (`cli/node-assert`).
const formatNodeAssertErrors = (error: unknown, expand: boolean): unknown =>
  isAssertionError(error) && typeof error.stack === 'string' && error.stack !== ''
    ? {message: assertionErrorMessage(error, {expand})}
    : error;

const getOperatorName = (operator: string | undefined, stack: string) => {
  if (typeof operator === 'string') {
    return assertOperatorsMap[operator] || operator;
  }
  if (stack.match('.doesNotThrow')) {
    return 'doesNotThrow';
  }
  if (stack.match('.throws')) {
    return 'throws';
  }
  return '';
};

const operatorMessage = (operator: string | undefined) => {
  const niceOperatorName = getOperatorName(operator, '');
  const humanReadableOperator = humanReadableOperators[niceOperatorName];

  return typeof operator === 'string'
    ? `${humanReadableOperator || niceOperatorName} to:\n`
    : '';
};

const assertThrowingMatcherHint = (operatorName: string) =>
  operatorName
    ? DIM_COLOR('assert') +
      DIM_COLOR(`.${operatorName}(`) +
      RECEIVED_COLOR('function') +
      DIM_COLOR(')')
    : '';

const assertMatcherHint = (
  operator: string | undefined | null,
  operatorName: string,
  expected: unknown,
) => {
  let message = '';

  if (operator === '==' && expected === true) {
    message =
      DIM_COLOR('assert') +
      DIM_COLOR('(') +
      RECEIVED_COLOR('received') +
      DIM_COLOR(')');
  } else if (operatorName) {
    message =
      DIM_COLOR('assert') +
      DIM_COLOR(`.${operatorName}(`) +
      RECEIVED_COLOR('received') +
      DIM_COLOR(', ') +
      EXPECTED_COLOR('expected') +
      DIM_COLOR(')');
  }

  return message;
};

function assertionErrorMessage(
  error: AssertionErrorWithStack,
  options: {expand: boolean},
) {
  const {expected, actual, generatedMessage, message, operator, stack} = error;
  const diffString = diff(expected, actual, options);
  const hasCustomMessage = !generatedMessage;
  const operatorName = getOperatorName(operator, stack);
  const trimmedStack = stack
    .replace(message, '')
    .replaceAll(/AssertionError(.*)/g, '');

  if (operatorName === 'doesNotThrow') {
    return (
      // eslint-disable-next-line prefer-template
      buildHintString(assertThrowingMatcherHint(operatorName)) +
      RESET('Expected the function not to throw an error.\n') +
      RESET('Instead, it threw:\n') +
      `  ${printReceived(actual)}` +
      RESET(hasCustomMessage ? `\n\nMessage:\n  ${message}` : '') +
      trimmedStack
    );
  }

  if (operatorName === 'throws') {
    if (error.generatedMessage) {
      return (
        buildHintString(assertThrowingMatcherHint(operatorName)) +
        RESET(error.message) +
        RESET(hasCustomMessage ? `\n\nMessage:\n  ${message}` : '') +
        trimmedStack
      );
    }
    return (
      buildHintString(assertThrowingMatcherHint(operatorName)) +
      RESET('Expected the function to throw an error.\n') +
      RESET("But it didn't throw anything.") +
      RESET(hasCustomMessage ? `\n\nMessage:\n  ${message}` : '') +
      trimmedStack
    );
  }

  if (operatorName === 'fail') {
    return (
      buildHintString(assertMatcherHint(operator, operatorName, expected)) +
      RESET(hasCustomMessage ? `Message:\n  ${message}` : '') +
      trimmedStack
    );
  }

  return (
    // eslint-disable-next-line prefer-template
    buildHintString(assertMatcherHint(operator, operatorName, expected)) +
    RESET(`Expected value ${operatorMessage(operator)}`) +
    `  ${printExpected(expected)}\n` +
    RESET('Received:\n') +
    `  ${printReceived(actual)}` +
    RESET(hasCustomMessage ? `\n\nMessage:\n  ${message}` : '') +
    (diffString ? `\n\nDifference:\n\n${diffString}` : '') +
    trimmedStack
  );
}

// provino: `node:assert`'s `AssertionError`, loaded the first time a value passes neither the name
// nor the code test.
let assertionErrorClass: typeof AssertionError | undefined;
const loadedAssertionError = (): typeof AssertionError =>
  (assertionErrorClass ??= process.getBuiltinModule('node:assert').AssertionError);

function isAssertionError(error: unknown): error is AssertionErrorWithStack {
  // provino: `error` is `unknown` here, so the property reads go through a cast; jest-circus's three
  // tests, the name (`AssertionError.name`) and code first and `instanceof` last, so `node:assert`
  // loads only for a value that is neither: the same answer.
  const candidate = error as {name?: unknown; code?: unknown} | null | undefined;
  return Boolean(
    candidate &&
      (candidate.name === 'AssertionError' ||
        candidate.code === 'ERR_ASSERTION' ||
        error instanceof loadedAssertionError()),
  );
}

function buildHintString(hint: string) {
  return hint ? `${hint}\n\n` : '';
}

export default formatNodeAssertErrors;
