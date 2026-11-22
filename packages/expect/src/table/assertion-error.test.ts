// The neutral `errorShape: 'assertion-error'` with Provino's table: a failure throws
// `ProvinoAssertionError` (B27e: the table had no `assertionError`, so a native run could not start).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createExpect, createMatcherRegistry, createStateSource } from '@provino/expect'
import { manualCurrentTest, testPolicy, testTask } from '../internal/test-support.ts'
import { ProvinoAssertionError, provinoExpectTable } from './index.ts'

function engine() {
  const current = manualCurrentTest()
  current.enter(testTask('t'))
  return createExpect({
    policy: { ...testPolicy, errorShape: 'assertion-error', settlementCheck: 'at-read' },
    table: provinoExpectTable(),
    source: createStateSource(current, { nameSeparator: ' > ', expand: false }),
    registry: createMatcherRegistry(),
  })
}

describe("Provino's table under errorShape: 'assertion-error'", () => {
  test('a failed matcher throws ProvinoAssertionError with the code, the matcher and the message', () => {
    const expect = engine()
    assert.throws(
      () => expect(1).toBe(2),
      (error: unknown) =>
        error instanceof ProvinoAssertionError &&
        error.name === 'AssertionError' &&
        error.code === 'EXPECT_ASSERTION_FAILED' &&
        error.matcherName === 'toBe' &&
        error.message.startsWith('expect(received).toBe(expected)') &&
        /Expected: 2/.test(error.message),
    )
  })

  test('a passing matcher throws nothing', () => {
    engine()({ a: 1 }).toEqual({ a: 1 })
  })

  test('.resolves on a rejection carries the reason as cause', async () => {
    const reason = new Error('no')
    await assert.rejects(
      () => engine()(Promise.reject(reason)).resolves.toBe(1),
      (error: unknown) => error instanceof ProvinoAssertionError && error.cause === reason,
    )
  })
})
