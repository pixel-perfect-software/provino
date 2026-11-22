// The neutral `errorShape: 'assertion-error'` with Provino's table: a failure throws
// `ProvinoAssertionError` (B27e: the table had no `assertionError`, so a native run could not start).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ExpectStatic } from '@provino/types'
import { type TestEngine, testEngine, testTask } from '../internal/test-support.ts'
import { ProvinoAssertionError } from './assertion-error.ts'
import { provinoExpectTable } from './index.ts'

const THIS_FILE = fileURLToPath(import.meta.url)

/** An engine under the neutral shape, with a test running. */
function engine(): TestEngine & { readonly expect: ExpectStatic } {
  const built = testEngine({
    table: provinoExpectTable(),
    policy: { errorShape: 'assertion-error', settlementCheck: 'at-read', soft: true },
  })
  built.current.enter(testTask('t'))
  return built
}

/** Asserts `error` is the table's error for `matcherName`, and returns it. */
function assertTableError(error: unknown, matcherName: string): ProvinoAssertionError {
  assert.ok(error instanceof ProvinoAssertionError, String(error))
  assert.equal(error.name, 'AssertionError')
  assert.equal(error.code, 'EXPECT_ASSERTION_FAILED')
  assert.equal(error.matcherName, matcherName)
  return error
}

describe("Provino's table under errorShape: 'assertion-error'", () => {
  test('a failed matcher throws ProvinoAssertionError with the code, the matcher and the message', () => {
    assert.throws(
      () => engine().expect(1).toBe(2),
      (error: unknown) => {
        const made = assertTableError(error, 'toBe')
        assert.match(made.message, /^expect\(received\)\.toBe\(expected\)/)
        assert.match(made.message, /Expected: 2/)
        return true
      },
    )
  })

  test('a passing matcher throws nothing', () => {
    engine().expect({ a: 1 }).toEqual({ a: 1 })
  })

  test('.not fails with the .not header', () => {
    assert.throws(
      () => engine().expect(1).not.toBe(1),
      (error: unknown) => /\.not\.toBe/.test(assertTableError(error, 'toBe').message),
    )
  })

  test('an asymmetric matcher that does not match fails as its matcher', () => {
    const { expect } = engine()
    assert.throws(
      () => expect({ a: 1 }).toEqual({ a: expect.any(String) }),
      (error: unknown) => assertTableError(error, 'toEqual') !== undefined,
    )
  })

  test('.resolves on a rejection carries the reason as cause', async () => {
    const reason = new Error('no')
    await assert.rejects(
      () => engine().expect(Promise.reject(reason)).resolves.toBe(1),
      (error: unknown) => assertTableError(error, 'toBe').cause === reason,
    )
  })

  test('.rejects on a resolution fails, with no cause', async () => {
    await assert.rejects(
      () => engine().expect(Promise.resolve(1)).rejects.toBe(1),
      (error: unknown) => assertTableError(error, 'toBe').cause === undefined,
    )
  })

  test('expect.soft holds the error and the test goes on', () => {
    const { expect, source } = engine()
    assert.ok(expect.soft !== undefined)
    expect.soft(1).toBe(2)
    const [held] = source.current().suppressedErrors
    assertTableError(held, 'toBe')
  })

  test("the stack's first frame is this file, not the engine", () => {
    let thrown: unknown
    try {
      engine().expect(1).toBe(2)
    } catch (error) {
      thrown = error
    }
    const frame = assertTableError(thrown, 'toBe')
      .stack?.split('\n')
      .find((line) => /^\s+at /.test(line))
    assert.ok(frame?.includes(THIS_FILE), frame)
  })
})
