import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { serializeError } from './serialize-error.ts'

describe('serializeError', () => {
  test('keeps name, message, stack and a string code', () => {
    const error = Object.assign(new TypeError('bad'), { code: 'E_BAD' })
    assert.deepEqual(serializeError(error), {
      name: 'TypeError',
      message: 'bad',
      stack: error.stack,
      code: 'E_BAD',
    })
  })

  test('leaves out a code that is not a string, and a stack that is missing', () => {
    const plain = { name: 'Custom', message: 'plain object', code: 42 }
    assert.deepEqual(serializeError(plain), { name: 'Custom', message: 'plain object' })
  })

  test('follows the cause chain', () => {
    const error = new Error('top', { cause: new Error('middle', { cause: 'root' }) })
    const serialized = serializeError(error)
    assert.equal(serialized.cause?.message, 'middle')
    assert.deepEqual(serialized.cause?.cause, { name: 'Error', message: 'root' })
  })

  test('stops a cause chain that loops back on itself', () => {
    const error = new Error('loop')
    error.cause = error
    let depth = 0
    for (let e = serializeError(error).cause; e !== undefined; e = e.cause) depth++
    assert.equal(depth, 10)
  })

  test('describes a value that is not an object by its text', () => {
    assert.deepEqual(serializeError('text'), { name: 'Error', message: 'text' })
    assert.deepEqual(serializeError(undefined), { name: 'Error', message: 'undefined' })
    assert.deepEqual(serializeError(Symbol('s')), { name: 'Error', message: 'Symbol(s)' })
  })

  test('survives a value whose text cannot be made', () => {
    const noText = { toString: 3 }
    assert.deepEqual(serializeError({ message: noText }), {
      name: 'Error',
      message: '[object Object]',
    })
  })
})
