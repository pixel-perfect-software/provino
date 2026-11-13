// `LazyPolicy.readInBeforeAll`: reading a test-scoped value in a suite hook.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LazyError } from './errors.ts'
import { createWorld } from './internal/test-support.ts'

describe('readInBeforeAll', () => {
  test("'error' throws LAZY_SCOPE with the fix in the message", async () => {
    const w = createWorld({ readInBeforeAll: 'error' })
    const outcome = await w.runFile('a.test.ts', () => {
      const $ = w.lazy.let('user', () => 1)
      w.beforeAll(() => void $.user)
      w.test('t', () => {})
    })
    const error = outcome.tests[0]?.error
    assert.ok(error instanceof LazyError)
    assert.equal(error.code, 'LAZY_SCOPE')
    assert.match(
      error.message,
      /test-scoped and cannot be read in beforeAll\. Read it in beforeEach, or declare it with \{ scope: 'file' \}/,
    )
  })

  test("'allow' evaluates it once per suite, and its task describes the suite", async () => {
    const w = createWorld({ readInBeforeAll: 'allow' })
    let calls = 0
    const seen: unknown[] = []
    const tasks: unknown[] = []
    const outcome = await w.runFile('a.test.ts', () => {
      const $ = w.lazy.let('user', (_d, ctx) => {
        calls++
        tasks.push(ctx.task)
        return 'u'
      })
      w.beforeAll(() => void seen.push($.user, $.user))
      w.test('t', () => void seen.push($.user))
    })
    assert.equal(outcome.tests[0]?.error, undefined)
    assert.equal(calls, 2)
    assert.deepEqual(seen, ['u', 'u', 'u'])
    assert.equal((tasks[0] as { name: string }).name, 'a.test.ts')
  })
})
