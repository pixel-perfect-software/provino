// T6.4: registration and collection-time validation. Each misuse throws a `LazyError` with the
// right code and the `file:line:column` of the call that made it.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LazyError } from './errors.ts'
import { createWorld } from './internal/test-support.ts'

function site(error: unknown): string {
  assert.ok(error instanceof LazyError, String(error))
  assert.ok(error.site)
  return `${error.site.file}:${error.site.line}:${error.site.column}`
}

function expectError(error: unknown, code: string): LazyError {
  assert.ok(error instanceof LazyError, `expected a LazyError, got ${String(error)}`)
  assert.equal(error.code, code)
  assert.match(site(error), /registration\.test\.ts:\d+:\d+$/)
  return error
}

describe('registration', () => {
  test('a duplicate key in one suite throws LAZY_DUPLICATE naming both sites', async () => {
    const world = createWorld()
    const outcome = await world.runFile('a.test.ts', () => {
      world.lazy.let('user', () => 1)
      world.lazy.let('user', () => 2)
    })
    const error = expectError(outcome.collectError, 'LAZY_DUPLICATE')
    assert.equal(error.sites.length, 2)
    assert.notEqual(error.sites[0]?.line, error.sites[1]?.line)
  })

  test('an override of a key no suite around defines throws LAZY_INVALID when the file is collected', async () => {
    const world = createWorld()
    const outcome = await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('user', () => 1)
      world.describe('d', () => {
        $.override('usr' as never, (() => 2) as never)
      })
    })
    expectError(outcome.collectError, 'LAZY_INVALID')
  })

  test('an override at the same level as the definition is a duplicate, not an override', async () => {
    const world = createWorld()
    const outcome = await world.runFile('a.test.ts', () => {
      world.lazy.let('user', () => 1).override('user', () => 2)
    })
    expectError(outcome.collectError, 'LAZY_DUPLICATE')
  })

  test('a file or worker scope inside a describe throws LAZY_INVALID', async () => {
    for (const scope of ['file', 'worker'] as const) {
      const world = createWorld()
      const outcome = await world.runFile('a.test.ts', () => {
        world.describe('d', () => {
          world.lazy.let('db', () => 1, { scope })
        })
      })
      expectError(outcome.collectError, 'LAZY_INVALID')
    }
  })

  test('a reserved key throws LAZY_RESERVED', async () => {
    for (const key of ['then', 'let', 'override', 'toJSON', 'constructor', 'asymmetricMatch']) {
      const world = createWorld()
      const outcome = await world.runFile('a.test.ts', () => {
        world.lazy.let(key as 'x', () => 1)
      })
      expectError(outcome.collectError, 'LAZY_RESERVED')
    }
  })

  test('a definition inside a test or a hook throws LAZY_NOT_COLLECTING', async () => {
    const world = createWorld()
    const seen: unknown[] = []
    await world.runFile('a.test.ts', () => {
      world.beforeEach(() => {
        try {
          world.lazy.let('a', () => 1)
        } catch (error) {
          seen.push(error)
        }
      })
      world.test('t', () => {
        try {
          world.lazy.eager('b', () => 1)
        } catch (error) {
          seen.push(error)
        }
        try {
          world.lazy.let('c', () => 1).override('c', () => 2)
        } catch (error) {
          seen.push(error)
        }
      })
    })
    assert.equal(seen.length, 3)
    for (const error of seen) expectError(error, 'LAZY_NOT_COLLECTING')
  })

  test('a bad scope, timeout, key or definition throws LAZY_INVALID', async () => {
    const bad: Array<() => unknown> = []
    const world = createWorld()
    bad.push(() => world.lazy.let('a', () => 1, { scope: 'suite' as never }))
    bad.push(() => world.lazy.let('a', () => 1, { timeout: -1 }))
    bad.push(() => world.lazy.let('a', 3 as never))
    bad.push(() => world.lazy.let('' as 'x', () => 1))
    const errors: unknown[] = []
    await world.runFile('a.test.ts', () => {
      for (const attempt of bad) {
        try {
          attempt()
        } catch (error) {
          errors.push(error)
        }
      }
    })
    assert.equal(errors.length, 4)
    for (const error of errors) expectError(error, 'LAZY_INVALID')
  })

  test('the same key in a nested describe is an override or a re-declare, not a duplicate', async () => {
    const world = createWorld()
    const outcome = await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('user', () => 1)
      world.describe('d', () => {
        $.override('user', () => 2)
        world.describe('e', () => {
          $.let('user', () => 3)
        })
      })
    })
    assert.equal(outcome.collectError, undefined)
  })

  test('the handle returned by let has a getter per key and no then', () => {
    const world = createWorld()
    world.collectOnly('a.test.ts', () => {
      const $ = world.lazy.let('a', () => 1).let('b', () => 2)
      assert.deepEqual(Object.keys($), ['a', 'b'])
      assert.equal('then' in $, false)
      assert.ok(Object.isFrozen($))
    })
  })
})
