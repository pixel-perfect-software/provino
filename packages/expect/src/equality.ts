// The equality policies (T7.7): the two places Vitest's `equals` differs from Jest's, as testers
// that go ahead of Jest's own `equals` (a tester that answers decides; `undefined` defers). The
// Jest dialect needs neither. Both are realm-safe: they ask `Object.prototype.toString` what a
// value is, never `instanceof` or `constructor ===`, so a value made in another `vm` context is
// judged by its class. Vitest 5.0.5's `jest-utils.ts` is the source (`eq` L164-L171 for dates,
// `isError` L93-L105 and `isErrorEqual` L253-L281 for errors).
import type { EqualityTester, ExpectPolicy } from '@provino/types'

const classTag = Object.prototype.toString

/** `Error.isError` where Node has it, else the class tag (which a subclass of `Error` has too). */
function isError(value: unknown): value is Error {
  // The target library (es2024) doesn't declare `Error.isError` yet.
  const native = (Error as { isError?: (candidate: unknown) => boolean }).isError
  if (typeof native === 'function') return native(value)
  switch (classTag.call(value)) {
    case '[object Error]':
    case '[object Exception]':
    case '[object DOMException]':
      return true
    default:
      return false
  }
}

const isDate = (value: unknown): value is Date => classTag.call(value) === '[object Date]'

/**
 * `invalidDate: 'equal'`: two dates that are both invalid (`NaN` milliseconds) are equal. Any
 * other pair is Jest's `equals` to judge.
 */
const invalidDatesAreEqual: EqualityTester = (a, b) =>
  isDate(a) && isDate(b) && Number.isNaN(+a) && Number.isNaN(+b) ? true : undefined

/** The pairs of errors being compared now (Vitest's `aStack` and `bStack`), so an error that is its own cause ends the walk. */
const comparing: [object, object][] = []

/**
 * `errors: 'assert'`: two errors are equal as `node:assert` has it: the same class, name and
 * message, the same `cause` when the expected one has one, the same `errors` for an
 * `AggregateError`, and the same own enumerable properties. Jest's `equals` compares only the
 * message.
 */
const errorsLikeAssert: EqualityTester = function (a, b, customTesters) {
  if (!isError(a) || !isError(b)) return undefined
  // Vitest's stack rule: an error met again, nested in itself, is equal only if it meets the same
  // partner as where it was first met, and a partner met again with another error is not.
  for (let i = comparing.length - 1; i >= 0; i--) {
    const pair = comparing[i]
    if (pair === undefined) continue
    if (pair[0] === a) return pair[1] === b
    if (pair[1] === b) return false
  }
  comparing.push([a, b])
  try {
    const sameKind =
      classTag.call(a) === classTag.call(b) && a.name === b.name && a.message === b.message
    if (!sameKind) return false
    // The cause is checked asymmetrically: only when the expected error has one.
    if (typeof b.cause !== 'undefined' && !this.equals(a.cause, b.cause, customTesters)) {
      return false
    }
    const aErrors: unknown = Reflect.get(a, 'errors')
    const bErrors: unknown = Reflect.get(b, 'errors')
    if (
      a.name === 'AggregateError' &&
      b.name === 'AggregateError' &&
      Array.isArray(aErrors) &&
      Array.isArray(bErrors) &&
      !this.equals(aErrors, bErrors, customTesters)
    ) {
      return false
    }
    return this.equals({ ...a }, { ...b }, customTesters)
  } finally {
    comparing.pop()
  }
}

/**
 * The testers an `ExpectPolicy.equality` asks for, in the order they go ahead of the others.
 * Jest's values ask for none.
 * @public
 */
export function equalityTesters(equality: ExpectPolicy['equality']): EqualityTester[] {
  return [
    ...(equality.errors === 'assert' ? [errorsLikeAssert] : []),
    ...(equality.invalidDate === 'equal' ? [invalidDatesAreEqual] : []),
  ]
}
