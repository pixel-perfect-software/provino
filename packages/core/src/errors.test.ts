// `serializeError` turns anything thrown into plain data that can cross a thread; the error
// classes carry stable names and codes.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { SerializedError } from '@provino/types'
import {
  AroundHookMultipleCallsError,
  AroundHookSetupError,
  AroundHookTeardownError,
  CoreError,
  serializeError,
} from './errors.ts'

describe('serializeError of an Error', () => {
  test('keeps the name, message and stack', () => {
    const error = new RangeError('out of range')
    const serialized = serializeError(error)
    assert.equal(serialized.name, 'RangeError')
    assert.equal(serialized.message, 'out of range')
    assert.equal(serialized.stack, error.stack)
  })

  test('leaves out the fields the error does not have', () => {
    const serialized = serializeError(new Error('plain'))
    assert.deepEqual(Object.keys(serialized).sort(), ['message', 'name', 'stack'])
  })

  test('keeps a string code, as on a CoreError', () => {
    const serialized = serializeError(new CoreError('CORE_TIMEOUT', 'too slow'))
    assert.equal(serialized.code, 'CORE_TIMEOUT')
    assert.equal(serialized.name, 'CoreError')
  })

  test('keeps a string code a library put on a plain Error', () => {
    const serialized = serializeError(Object.assign(new Error('x'), { code: 'ENOENT' }))
    assert.equal(serialized.code, 'ENOENT')
  })

  test('drops a code that is not a string', () => {
    const serialized = serializeError(Object.assign(new Error('x'), { code: 2 }))
    assert.equal('code' in serialized, false)
  })

  test('has no stack when reading it throws', () => {
    const error = new Error('x')
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error('no stack for you')
      },
    })
    const serialized = serializeError(error)
    assert.equal(serialized.message, 'x')
    assert.equal('stack' in serialized, false)
  })
})

describe('serializeError of a failed assertion’s matcherResult', () => {
  const withResult = (matcherResult: unknown): Error =>
    Object.assign(new Error('expected 1 to be 2'), { matcherResult })

  test('copies only its name and pass', () => {
    const serialized = serializeError(
      withResult({ name: 'toBe', pass: false, message: 'm', actual: 1, expected: () => 2 }),
    )
    assert.deepEqual(serialized.matcherResult, { name: 'toBe', pass: false })
    assert.deepEqual(Object.keys(serialized.matcherResult ?? {}), ['name', 'pass'])
    assert.doesNotThrow(() => structuredClone(serialized))
  })

  test('is absent when the error has none', () => {
    assert.equal('matcherResult' in serializeError(new Error('x')), false)
  })

  test('is absent unless name is a string and pass a boolean', () => {
    for (const matcherResult of [
      undefined,
      null,
      'toBe',
      () => ({ name: 'toBe', pass: true }),
      {},
      { name: 'toBe' },
      { pass: true },
      { name: 3, pass: true },
      { name: 'toBe', pass: 'yes' },
    ]) {
      assert.equal(
        'matcherResult' in serializeError(withResult(matcherResult)),
        false,
        String(matcherResult),
      )
    }
  })

  test('is read from a cause as well', () => {
    const serialized = serializeError(
      new Error('outer', { cause: withResult({ name: 'toEqual', pass: false }) }),
    )
    assert.deepEqual(serialized.cause?.matcherResult, { name: 'toEqual', pass: false })
    assert.equal('matcherResult' in serialized, false)
  })

  test('never throws, however it is hostile', () => {
    const throwing = (): never => {
      throw new Error('trap')
    }
    const getter = new Error('x')
    Object.defineProperty(getter, 'matcherResult', { get: throwing })
    const fields = Object.defineProperties({}, { name: { get: throwing }, pass: { get: throwing } })
    const { proxy, revoke } = Proxy.revocable({ name: 'toBe', pass: true }, {})
    revoke()
    const hostile = new Proxy({ name: 'toBe', pass: true }, { get: throwing, has: throwing })
    for (const error of [getter, withResult(fields), withResult(proxy), withResult(hostile)]) {
      assert.equal('matcherResult' in serializeError(error), false)
    }
  })
})

describe('serializeError of a cause chain', () => {
  test('serializes each cause in turn', () => {
    const error = new Error('outer', {
      cause: new TypeError('middle', { cause: new Error('root') }),
    })
    const serialized = serializeError(error)
    assert.equal(serialized.cause?.name, 'TypeError')
    assert.equal(serialized.cause?.message, 'middle')
    assert.equal(serialized.cause?.cause?.message, 'root')
    assert.equal(serialized.cause?.cause?.cause, undefined)
  })

  test('serializes a cause that is not an error as an error with its string form', () => {
    const serialized = serializeError(new Error('outer', { cause: 'because' }))
    assert.deepEqual(serialized.cause, { name: 'Error', message: 'because' })
  })

  test('stops on a cause that points back at the error', () => {
    const error = new Error('loop')
    error.cause = error
    let depth = 0
    for (let node = serializeError(error); node.cause !== undefined; node = node.cause) depth++
    assert.ok(depth < 20, `followed the loop ${depth} times`)
  })
})

describe('serializeError of an AggregateError', () => {
  test('serializes each error it holds', () => {
    const error = new AggregateError([new Error('a'), new TypeError('b'), 'c'], 'many')
    const serialized = serializeError(error)
    assert.equal(serialized.message, 'many')
    assert.deepEqual(
      serialized.errors?.map((inner) => [inner.name, inner.message]),
      [
        ['Error', 'a'],
        ['TypeError', 'b'],
        ['Error', 'c'],
      ],
    )
  })

  test('is clone-safe, causes and errors included', () => {
    const error = new AggregateError([new Error('a', { cause: 'x' })], 'many', { cause: 'y' })
    const serialized = serializeError(error)
    assert.deepEqual(structuredClone(serialized), serialized)
  })

  test('an AggregateError from another realm keeps its errors', () => {
    const foreign: unknown = runInNewContext('new AggregateError([new Error("a")], "many")')
    assert.equal(foreign instanceof AggregateError, false)
    assert.deepEqual(
      serializeError(foreign).errors?.map((inner) => inner.message),
      ['a'],
    )
  })

  test('an aggregate that holds itself is expanded once, not once per path', () => {
    const error = new AggregateError([], 'self')
    for (let index = 0; index < 4; index++) error.errors.push(error)
    const serialized = serializeError(error)
    assert.equal(countErrors(serialized), 5)
    assert.equal(serialized.errors?.[0]?.message, 'self')
  })

  test('an aggregate whose errors getter makes new ones on every read stops at a budget', () => {
    const fresh = (): AggregateError => {
      const error = new AggregateError([], 'fresh')
      Object.defineProperty(error, 'errors', { get: () => [fresh(), fresh(), fresh(), fresh()] })
      return error
    }
    const count = countErrors(serializeError(fresh()))
    assert.ok(count > 1 && count <= 1000, `serialized ${count} errors`)
  })
})

/** How many errors a serialized tree holds, causes and aggregated errors included. */
function countErrors(error: SerializedError): number {
  let count = 1
  if (error.cause !== undefined) count += countErrors(error.cause)
  for (const inner of error.errors ?? []) count += countErrors(inner)
  return count
}

describe('serializeError never throws', () => {
  test('for an error whose name and message getters throw', () => {
    const error = new Error('x')
    for (const key of ['name', 'message', 'code', 'cause', 'errors']) {
      Object.defineProperty(error, key, {
        get() {
          throw new Error(`no ${key}`)
        },
      })
    }
    const serialized = serializeError(error)
    assert.equal(serialized.name, 'Error')
    assert.equal(typeof serialized.message, 'string')
  })

  test('for a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable(new Error('x'), {})
    revoke()
    assert.equal(serializeError(proxy).name, 'Error')
  })

  test('for a proxy whose every trap throws', () => {
    const fail = (): never => {
      throw new Error('trap')
    }
    const hostile = new Proxy(new Error('x'), {
      get: fail,
      has: fail,
      getPrototypeOf: fail,
      ownKeys: fail,
      getOwnPropertyDescriptor: fail,
    })
    assert.equal(serializeError(hostile).name, 'Error')
  })

  test('for an aggregate whose errors are a proxy that throws on read', () => {
    const error = new AggregateError([], 'many')
    Object.defineProperty(error, 'errors', {
      value: new Proxy([1, 2], {
        get() {
          throw new Error('trap')
        },
      }),
    })
    assert.equal(serializeError(error).message, 'many')
  })
})

describe('serializeError of a value that is not an error', () => {
  for (const [what, value, message] of [
    ['a string', 'boom', 'boom'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a symbol', Symbol('s'), 'Symbol(s)'],
    ['an object with no message', { reason: 1 }, '[object Object]'],
  ] as const) {
    test(`${what} becomes an Error whose message is its string form`, () => {
      assert.deepEqual(serializeError(value), { name: 'Error', message })
    })
  }

  test('an object whose toString throws still serializes', () => {
    const hostile = {
      toString() {
        throw new Error('no')
      },
    }
    assert.deepEqual(serializeError(hostile), { name: 'Error', message: '[object Object]' })
  })

  test('an error from another realm (anything with a message and a stack) keeps its name', () => {
    const foreign = {
      name: 'TypeError',
      message: 'from a vm',
      stack: 'TypeError: from a vm\n  at x',
    }
    assert.deepEqual(serializeError(foreign), {
      name: 'TypeError',
      message: 'from a vm',
      stack: foreign.stack,
    })
  })

  test('a message that is not a string is turned into one', () => {
    assert.equal(serializeError({ message: 42, stack: 's' }).message, '42')
  })
})

describe('the error classes', () => {
  test('a CoreError is an Error with a stable code', () => {
    const error = new CoreError('CORE_BUSY', 'busy', { cause: 'x' })
    assert.ok(error instanceof Error)
    assert.equal(error.code, 'CORE_BUSY')
    assert.equal(error.cause, 'x')
  })

  test('the around-hook errors are told apart by name', () => {
    assert.equal(new AroundHookSetupError('m').name, 'AroundHookSetupError')
    assert.equal(new AroundHookTeardownError('m').name, 'AroundHookTeardownError')
    assert.equal(new AroundHookMultipleCallsError('m').name, 'AroundHookMultipleCallsError')
  })
})
