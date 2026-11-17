// An error's text never says `undefined` and never dumps an object: a cause or an error with no
// message is its name, or nothing at all when it holds nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SerializedError } from '@provino/types'
import { error } from '../internal/test-support.ts'
import { formatError, header } from './format.ts'

/** What crosses a link can be anything: an error with no message, as a plain object has none. */
const messageless = (extra: Partial<SerializedError> = {}): SerializedError =>
  ({ name: 'Error', ...extra }) as SerializedError

test('an error with no message is its name, never the word undefined', () => {
  assert.equal(header(messageless()), 'Error')
  assert.equal(header(messageless({ name: 'WorkerCrash' })), 'WorkerCrash')
  assert.equal(formatError(messageless({ name: 'WorkerCrash' })), 'WorkerCrash')
})

test('a cause that holds nothing is left out, and one with a name or a message is printed', () => {
  const empty = formatError(error('top', { cause: messageless() }))
  assert.equal(empty, 'top')
  assert.equal(formatError(error('top', { cause: error('') })), 'top')
  assert.equal(
    formatError(error('top', { cause: messageless({ name: 'WorkerCrash' }) })),
    'top\n\nCaused by:\n  WorkerCrash',
  )
  assert.equal(formatError(error('top', { cause: error('inner') })), 'top\n\nCaused by:\n  inner')
  assert.doesNotMatch(empty, /undefined|\[object/)
})
