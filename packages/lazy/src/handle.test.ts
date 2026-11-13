// The handle's own surface: how it prints and serializes without evaluating anything.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { inspect } from 'node:util'
import { createWorld, type FileOutcome } from './internal/test-support.ts'

function passed(outcome: FileOutcome): void {
  assert.equal(outcome.collectError, undefined)
  for (const t of outcome.tests) assert.equal(t.error, undefined, `${t.name}: ${String(t.error)}`)
}

describe('handle', () => {
  test('inspect, toJSON and toString read nothing', async () => {
    const w = createWorld()
    let calls = 0
    const printed: string[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy
          .let('user', () => ({ name: 'Ada' }))
          .let('cart', () => {
            calls++
            return 1
          })
        w.test('t', () => {
          void $.user
          printed.push(inspect($), JSON.stringify($), String($), Object.prototype.toString.call($))
        })
      }),
    )
    assert.equal(calls, 0)
    assert.deepEqual(printed, [
      "Lazy { user: { name: 'Ada' }, cart: <lazy> }",
      '{"lazy":["user","cart"]}',
      '[object Lazy]',
      '[object Lazy]',
    ])
  })

  test('printing outside a test shows every key as not evaluated', () => {
    const w = createWorld()
    w.collectOnly('a.test.ts', () => {
      const $ = w.lazy.let('a', () => 1)
      assert.equal(inspect($), 'Lazy { a: <lazy> }')
    })
  })

  test('the methods are not enumerable and the handle is frozen', () => {
    const w = createWorld()
    w.collectOnly('a.test.ts', () => {
      const $ = w.lazy.let('a', () => 1)
      assert.deepEqual(Object.keys($), ['a'])
      assert.ok(Object.isFrozen($))
      assert.equal(typeof $.override, 'function')
    })
  })

  test('override returns the same handle, so overrides chain', () => {
    const w = createWorld()
    w.collectOnly('a.test.ts', () => {
      const $ = w.lazy.let('a', () => 1).let('b', () => 2)
      w.describe('d', () => {
        assert.equal(
          $.override('a', () => 3).override('b', () => 4),
          $,
        )
      })
    })
  })
})
