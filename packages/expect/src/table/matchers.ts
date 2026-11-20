// Provino's own matchers (D188). The equality is the vendored `equals` (compat: what `toEqual`
// means to a user); the printing and the words are Provino's. A wrong argument is an
// `ExpectError` (`EXPECT_INVALID_ARGUMENT`), not a failed assertion.

import { types } from 'node:util'
import {
  arrayBufferEquality,
  ExpectError,
  getPath,
  iterableEquality,
  sparseArrayEquality,
  subsetEquality,
  typeEquality,
} from '@provino/expect'
import type { MatcherSet } from '@provino/types'
import { show } from './print.ts'
import { aligned, expectedReceived, result, type Self, testersWith } from './result.ts'

const invalid = (name: string, what: string, value: unknown): ExpectError =>
  new ExpectError('EXPECT_INVALID_ARGUMENT', `${name}: ${what}, but it is ${show(value)}`)

const isNumeric = (value: unknown): value is number | bigint =>
  typeof value === 'number' || typeof value === 'bigint'

const isIterable = (value: unknown): value is Iterable<unknown> =>
  value !== null &&
  value !== undefined &&
  typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'

/** A compare of two numbers: `pass` from `test`, the words from `phrase`. */
function compare(
  name: string,
  phrase: string,
  test: (received: number | bigint, expected: number | bigint) => boolean,
) {
  return function (this: Self, received: unknown, expected: unknown) {
    if (!isNumeric(received))
      throw invalid(name, 'the received value must be a number or bigint', received)
    if (!isNumeric(expected))
      throw invalid(name, 'the expected value must be a number or bigint', expected)
    return result(this, name, 'expected', test(received, expected), () =>
      aligned(this, 'Expected', `${phrase} ${show(expected)}`, 'Received', `${show(received)}`),
    )
  }
}

/** The check of a value against `true`/`false`/`null`/`undefined`/`NaN` and the like. */
function state(name: string, describe: string, test: (received: unknown) => boolean) {
  return function (this: Self, received: unknown) {
    return result(this, name, '', test(received), () =>
      aligned(this, 'Expected', `${describe}`, 'Received', `${show(received)}`),
    )
  }
}

function equality(name: string, strict: boolean) {
  return function (this: Self, received: unknown, expected: unknown) {
    const testers = strict
      ? [
          ...this.customTesters,
          iterableEquality,
          typeEquality,
          sparseArrayEquality,
          arrayBufferEquality,
        ]
      : testersWith(this, iterableEquality)
    const pass = this.equals(received, expected, testers, strict)
    return result(
      this,
      name,
      'expected',
      pass,
      () => expectedReceived(this, expected, received, { withDiff: true }),
      { actual: received, expected },
    )
  }
}

/** Whether `value` can be the right-hand side of `instanceof`: a function that constructs. */
function isConstructor(value: unknown): value is abstract new (...args: never[]) => unknown {
  if (typeof value !== 'function') return false
  try {
    Reflect.construct(Object, [], value)
    return true
  } catch {
    return false
  }
}

/** `instanceof`, except that `Error` also takes an error made in another realm. */
const isInstance = (received: unknown, ctor: abstract new (...args: never[]) => unknown) =>
  received instanceof ctor || (ctor === Error && types.isNativeError(received))

/** What a thrown value must look like, as `toThrow` takes it. */
function throwsAs(received: unknown, expected: unknown): boolean {
  if (expected === undefined) return true
  const error = types.isNativeError(received) ? received : undefined
  if (typeof expected === 'string') return error?.message.includes(expected) === true
  if (types.isRegExp(expected)) return error !== undefined && expected.test(error.message)
  if (isConstructor(expected)) return isInstance(received, expected)
  if (types.isNativeError(expected)) return error?.message === expected.message
  if (typeof expected === 'object' && expected !== null && 'asymmetricMatch' in expected) {
    return (expected as { asymmetricMatch(other: unknown): boolean }).asymmetricMatch(received)
  }
  throw invalid(
    'toThrow',
    'the expected value must be a string, a RegExp, an Error, an error class or an asymmetric matcher',
    expected,
  )
}

function toThrowOn(
  self: Self,
  thrownValue: { thrown: boolean; value: unknown },
  expected: unknown,
) {
  const pass = thrownValue.thrown && throwsAs(thrownValue.value, expected)
  return result(self, 'toThrow', expected === undefined ? '' : 'expected', pass, () => {
    const got = thrownValue.thrown ? `Thrown: ${show(thrownValue.value)}` : 'Thrown: nothing'
    return expected === undefined
      ? `Expected: ${self.isNot ? 'no error' : 'an error'}\n${got}`
      : `Expected: ${self.isNot ? 'not ' : ''}${show(expected)}\n${got}`
  })
}

interface MockLike {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[]
    readonly results: readonly { readonly type: string; readonly value: unknown }[]
  }
}

function mockOf(name: string, received: unknown): MockLike['mock'] {
  const mock = (received as Partial<MockLike> | null | undefined)?.mock
  if (!mock || !Array.isArray(mock.calls) || !Array.isArray(mock.results)) {
    throw invalid(name, 'the received value must be a mock function', received)
  }
  return mock
}

const listCalls = (calls: readonly (readonly unknown[])[]): string =>
  calls.length === 0
    ? 'Calls: none'
    : `Calls:\n${calls.map((args, index) => `  ${index + 1}: ${show(args)}`).join('\n')}`

function calledWith(name: string, pick: 'any' | 'last') {
  return function (this: Self, received: unknown, ...expected: unknown[]) {
    const { calls } = mockOf(name, received)
    const testers = testersWith(this, iterableEquality)
    const matches = (args: readonly unknown[]): boolean => this.equals(args, expected, testers)
    const pass =
      pick === 'any' ? calls.some(matches) : calls.length > 0 && matches(calls.at(-1) ?? [])
    return result(
      this,
      name,
      '...expected',
      pass,
      () => `Expected: ${this.isNot ? 'not ' : ''}${show(expected)}\n${listCalls(calls)}`,
    )
  }
}

const returned = (results: MockLike['mock']['results']): readonly unknown[] =>
  results.flatMap((r) => (r.type === 'return' ? [r.value] : []))

/** Provino's matchers. */
export const matchers: MatcherSet = {
  toBe(this: Self, received: unknown, expected: unknown) {
    const pass = Object.is(received, expected)
    return result(
      this,
      'toBe',
      'expected',
      pass,
      () => {
        const lines = expectedReceived(this, expected, received, { withDiff: false })
        const sameShape =
          !this.isNot &&
          typeof received === 'object' &&
          received !== null &&
          this.equals(received, expected)
        return sameShape
          ? `${lines}\n\nThe values are equal but not the same object; use toEqual to compare them by value.`
          : lines
      },
      { actual: received, expected },
    )
  },
  toEqual: equality('toEqual', false),
  toStrictEqual: equality('toStrictEqual', true),
  toMatchObject(this: Self, received: unknown, expected: unknown) {
    if (typeof received !== 'object' || received === null) {
      throw invalid('toMatchObject', 'the received value must be a non-null object', received)
    }
    if (typeof expected !== 'object' || expected === null) {
      throw invalid('toMatchObject', 'the expected value must be a non-null object', expected)
    }
    const pass = this.equals(received, expected, [
      ...this.customTesters,
      iterableEquality,
      subsetEquality,
    ])
    return result(
      this,
      'toMatchObject',
      'expected',
      pass,
      () =>
        expectedReceived(this, expected, received, { label: 'Expected subset', withDiff: true }),
      { actual: received, expected },
    )
  },
  toContain(this: Self, received: unknown, expected: unknown) {
    if (typeof received === 'string') {
      if (typeof expected !== 'string') {
        throw invalid(
          'toContain',
          'the expected value must be a string when the received one is',
          expected,
        )
      }
      return result(this, 'toContain', 'expected', received.includes(expected), () =>
        expectedReceived(this, expected, received, { label: 'Expected substring' }),
      )
    }
    if (!isIterable(received)) {
      throw invalid('toContain', 'the received value must be a string or an iterable', received)
    }
    return result(this, 'toContain', 'expected', Array.from(received).includes(expected), () =>
      expectedReceived(this, expected, received, { label: 'Expected item' }),
    )
  },
  toContainEqual(this: Self, received: unknown, expected: unknown) {
    if (!isIterable(received)) {
      throw invalid('toContainEqual', 'the received value must be an iterable', received)
    }
    const testers = testersWith(this, iterableEquality)
    const pass = Array.from(received).some((item) => this.equals(item, expected, testers))
    return result(this, 'toContainEqual', 'expected', pass, () =>
      expectedReceived(this, expected, received, { label: 'Expected item' }),
    )
  },
  toHaveLength(this: Self, received: unknown, expected: unknown) {
    const length = (received as { length?: unknown } | null | undefined)?.length
    if (typeof length !== 'number') {
      throw invalid('toHaveLength', 'the received value must have a numeric length', received)
    }
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      throw invalid('toHaveLength', 'the expected value must be a non-negative integer', expected)
    }
    return result(
      this,
      'toHaveLength',
      'expected',
      length === expected,
      () =>
        `${aligned(this, 'Expected length', `${expected}`, 'Received length', `${length}`)}\nReceived value: ${show(received)}`,
    )
  },
  toHaveProperty(this: Self, received: unknown, path: unknown, ...rest: unknown[]) {
    if (received === null || received === undefined) {
      throw invalid('toHaveProperty', 'the received value must not be null or undefined', received)
    }
    if (typeof path !== 'string' && !Array.isArray(path)) {
      throw invalid('toHaveProperty', 'the path must be a string or an array', path)
    }
    const hasValue = rest.length > 0
    const found = getPath(received, path as string | string[])
    const pass =
      found.hasEndProp === true &&
      (!hasValue || this.equals(found.value, rest[0], testersWith(this, iterableEquality)))
    const shown = typeof path === 'string' ? path : show(path)
    return result(this, 'toHaveProperty', hasValue ? 'path, value' : 'path', pass, () => {
      if (!hasValue) {
        return `Expected path: ${this.isNot ? 'not ' : ''}${shown}\nReceived value: ${show(received)}`
      }
      return found.hasEndProp === true
        ? `Expected path: ${shown}\n\n${expectedReceived(this, rest[0], found.value, { withDiff: true })}`
        : `Expected path: ${shown}\nReceived: the path does not exist in ${show(received)}`
    })
  },
  toBeTruthy: state('toBeTruthy', 'a truthy value', Boolean),
  toBeFalsy: state('toBeFalsy', 'a falsy value', (value) => !value),
  toBeNull: state('toBeNull', 'null', (value) => value === null),
  toBeUndefined: state('toBeUndefined', 'undefined', (value) => value === undefined),
  toBeDefined: state('toBeDefined', 'a defined value', (value) => value !== undefined),
  toBeNaN: state('toBeNaN', 'NaN', (value) => Number.isNaN(value)),
  toBeGreaterThan: compare('toBeGreaterThan', '>', (a, b) => a > b),
  toBeGreaterThanOrEqual: compare('toBeGreaterThanOrEqual', '>=', (a, b) => a >= b),
  toBeLessThan: compare('toBeLessThan', '<', (a, b) => a < b),
  toBeLessThanOrEqual: compare('toBeLessThanOrEqual', '<=', (a, b) => a <= b),
  toBeCloseTo(this: Self, received: unknown, expected: unknown, digits: unknown = 2) {
    if (typeof received !== 'number')
      throw invalid('toBeCloseTo', 'the received value must be a number', received)
    if (typeof expected !== 'number')
      throw invalid('toBeCloseTo', 'the expected value must be a number', expected)
    if (typeof digits !== 'number')
      throw invalid('toBeCloseTo', 'the digits must be a number', digits)
    const limit = 10 ** -digits / 2
    const difference = Math.abs(expected - received)
    const pass = received === expected || (Number.isFinite(difference) && difference < limit)
    return result(
      this,
      'toBeCloseTo',
      'expected, digits',
      pass,
      () =>
        `${aligned(this, 'Expected', `${show(expected)} (within ${limit})`, 'Received', `${show(received)}`)}\nDifference: ${difference}`,
    )
  },
  toMatch(this: Self, received: unknown, expected: unknown) {
    if (typeof received !== 'string')
      throw invalid('toMatch', 'the received value must be a string', received)
    if (typeof expected !== 'string' && !(expected instanceof RegExp)) {
      throw invalid('toMatch', 'the expected value must be a string or a RegExp', expected)
    }
    let pass: boolean
    if (typeof expected === 'string') pass = received.includes(expected)
    else {
      expected.lastIndex = 0
      pass = expected.test(received)
      expected.lastIndex = 0
    }
    return result(this, 'toMatch', 'expected', pass, () =>
      expectedReceived(this, expected, received, {
        label: typeof expected === 'string' ? 'Expected substring' : 'Expected pattern',
      }),
    )
  },
  toThrow(this: Self, received: unknown, expected?: unknown) {
    if (typeof received !== 'function') {
      throw invalid('toThrow', 'the received value must be a function', received)
    }
    let outcome: { thrown: boolean; value: unknown } = { thrown: false, value: undefined }
    try {
      received()
    } catch (error) {
      outcome = { thrown: true, value: error }
    }
    return toThrowOn(this, outcome, expected)
  },
  toBeInstanceOf(this: Self, received: unknown, expected: unknown) {
    if (!isConstructor(expected)) {
      throw invalid('toBeInstanceOf', 'the expected value must be a class or function', expected)
    }
    return result(
      this,
      'toBeInstanceOf',
      'expected',
      isInstance(received, expected),
      () =>
        `Expected constructor: ${this.isNot ? 'not ' : ''}${expected.name || show(expected)}\nReceived value: ${show(received)}`,
    )
  },
  toBeTypeOf(this: Self, received: unknown, expected: unknown) {
    const types = [
      'bigint',
      'boolean',
      'function',
      'number',
      'object',
      'string',
      'symbol',
      'undefined',
    ]
    if (typeof expected !== 'string' || !types.includes(expected)) {
      throw invalid('toBeTypeOf', `the expected value must be one of ${types.join(', ')}`, expected)
    }
    return result(
      this,
      'toBeTypeOf',
      'expected',
      typeof received === expected,
      () =>
        `${aligned(this, 'Expected type', `${expected}`, 'Received type', `${typeof received}`)}\nReceived value: ${show(received)}`,
    )
  },
  toSatisfy(this: Self, received: unknown, predicate: unknown) {
    if (typeof predicate !== 'function') {
      throw invalid('toSatisfy', 'the predicate must be a function', predicate)
    }
    return result(
      this,
      'toSatisfy',
      'predicate',
      Boolean(predicate(received)),
      () =>
        `Expected: ${this.isNot ? 'a value the predicate rejects' : 'a value the predicate accepts'}\nReceived: ${show(received)}`,
    )
  },
  toHaveBeenCalled(this: Self, received: unknown) {
    const { calls } = mockOf('toHaveBeenCalled', received)
    return result(
      this,
      'toHaveBeenCalled',
      '',
      calls.length > 0,
      () => `Expected: ${this.isNot ? 'no calls' : 'at least one call'}\n${listCalls(calls)}`,
    )
  },
  toHaveBeenCalledTimes(this: Self, received: unknown, expected: unknown) {
    const { calls } = mockOf('toHaveBeenCalledTimes', received)
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      throw invalid(
        'toHaveBeenCalledTimes',
        'the expected count must be a non-negative integer',
        expected,
      )
    }
    return result(this, 'toHaveBeenCalledTimes', 'expected', calls.length === expected, () =>
      aligned(this, 'Expected calls', `${expected}`, 'Received calls', `${calls.length}`),
    )
  },
  toHaveBeenCalledWith: calledWith('toHaveBeenCalledWith', 'any'),
  toHaveBeenLastCalledWith: calledWith('toHaveBeenLastCalledWith', 'last'),
  toHaveBeenNthCalledWith(this: Self, received: unknown, nth: unknown, ...expected: unknown[]) {
    const { calls } = mockOf('toHaveBeenNthCalledWith', received)
    if (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 1) {
      throw invalid('toHaveBeenNthCalledWith', 'the call number must be a positive integer', nth)
    }
    const call = calls[nth - 1]
    const pass =
      call !== undefined && this.equals(call, expected, testersWith(this, iterableEquality))
    return result(
      this,
      'toHaveBeenNthCalledWith',
      'n, ...expected',
      pass,
      () =>
        `Call ${nth}, expected: ${this.isNot ? 'not ' : ''}${show(expected)}\n${listCalls(calls)}`,
    )
  },
  toHaveReturned(this: Self, received: unknown) {
    const { results } = mockOf('toHaveReturned', received)
    return result(
      this,
      'toHaveReturned',
      '',
      results.some((r) => r.type === 'return'),
      () =>
        `Expected: ${this.isNot ? 'no returns' : 'at least one return'}\nResults: ${show(results)}`,
    )
  },
  toHaveReturnedWith(this: Self, received: unknown, expected: unknown) {
    const { results } = mockOf('toHaveReturnedWith', received)
    const testers = testersWith(this, iterableEquality)
    const pass = results.some((r) => r.type === 'return' && this.equals(r.value, expected, testers))
    return result(
      this,
      'toHaveReturnedWith',
      'expected',
      pass,
      () => `Expected: ${this.isNot ? 'not ' : ''}${show(expected)}\nResults: ${show(results)}`,
    )
  },
  toHaveReturnedTimes(this: Self, received: unknown, expected: unknown) {
    const { results } = mockOf('toHaveReturnedTimes', received)
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      throw invalid(
        'toHaveReturnedTimes',
        'the expected count must be a non-negative integer',
        expected,
      )
    }
    const count = returned(results).length
    return result(this, 'toHaveReturnedTimes', 'expected', count === expected, () =>
      aligned(this, 'Expected returns', `${expected}`, 'Received returns', `${count}`),
    )
  },
  toHaveLastReturnedWith(this: Self, received: unknown, expected: unknown) {
    const { results } = mockOf('toHaveLastReturnedWith', received)
    const last = results.at(-1)
    const pass =
      last !== undefined &&
      last.type === 'return' &&
      this.equals(last.value, expected, testersWith(this, iterableEquality))
    return result(
      this,
      'toHaveLastReturnedWith',
      'expected',
      pass,
      () => `Expected: ${this.isNot ? 'not ' : ''}${show(expected)}\nResults: ${show(results)}`,
    )
  },
  toHaveNthReturnedWith(this: Self, received: unknown, nth: unknown, expected: unknown) {
    const { results } = mockOf('toHaveNthReturnedWith', received)
    if (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 1) {
      throw invalid('toHaveNthReturnedWith', 'the return number must be a positive integer', nth)
    }
    const nthResult = results[nth - 1]
    const pass =
      nthResult !== undefined &&
      nthResult.type === 'return' &&
      this.equals(nthResult.value, expected, testersWith(this, iterableEquality))
    return result(
      this,
      'toHaveNthReturnedWith',
      'n, expected',
      pass,
      () =>
        `Return ${nth}, expected: ${this.isNot ? 'not ' : ''}${show(expected)}\nResults: ${show(results)}`,
    )
  },
}

/** Under `.rejects`, `toThrow` reads the rejection reason, not a function it calls. */
export const promiseMatchers: MatcherSet = {
  toThrow(this: Self, received: unknown, expected?: unknown) {
    if (this.promise !== 'rejects') {
      throw invalid('toThrow', 'it needs a function, or a promise under .rejects', received)
    }
    return toThrowOn(this, { thrown: true, value: received }, expected)
  },
}
