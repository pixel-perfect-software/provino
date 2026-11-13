// T6.6: `eager` runs as a hook at its declaration position and awaits its value.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LAZY_CHAIN, LazyError } from './errors.ts'
import { createWorld, type FileOutcome } from './internal/test-support.ts'

function passed(outcome: FileOutcome): void {
  assert.equal(outcome.collectError, undefined)
  for (const t of outcome.tests) assert.equal(t.error, undefined, `${t.name}: ${String(t.error)}`)
}

describe('eager', () => {
  test('runs between the hooks declared before and after it, and later hooks see the awaited value', async () => {
    const w = createWorld()
    const order: string[] = []
    const seen: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        w.beforeEach(() => void order.push('before-1'))
        const $ = w.lazy.eager('db', async () => {
          order.push('eager')
          return { open: true }
        })
        w.beforeEach(() => {
          order.push('before-2')
          seen.push($.db)
        })
        w.test('t', () => void seen.push($.db))
      }),
    )
    assert.deepEqual(order, ['before-1', 'eager', 'before-2'])
    assert.deepEqual(seen, [{ open: true }, { open: true }])
  })

  test('an earlier hook reading it throws LAZY_EAGER_PENDING', async () => {
    const w = createWorld()
    let error: unknown
    passed(
      await w.runFile('a.test.ts', () => {
        // The handle that `eager` returns exists only after the call: an earlier hook reads it late.
        let later: { readonly db: unknown } | undefined
        w.beforeEach(() => {
          try {
            later?.db
          } catch (thrown) {
            error = thrown
          }
        })
        later = w.lazy.eager('db', async () => 1)
        w.test('t', () => {})
      }),
    )
    assert.ok(error instanceof LazyError)
    assert.equal(error.code, 'LAZY_EAGER_PENDING')
  })

  test('an eager value is read once per test, and a test-level override replaces what the hook evaluates', async () => {
    const w = createWorld()
    const seen: unknown[] = []
    let calls = 0
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.eager('db', async () => `db${++calls}`)
        w.test('one', () => void seen.push($.db))
        w.describe('d', () => {
          $.override('db', async (_d, { parent }) => `${await parent()}+override`)
          w.test('two', () => void seen.push($.db))
        })
      }),
    )
    assert.deepEqual(seen, ['db1', 'db2+override'])
    assert.equal(calls, 2)
  })

  test('a rejected eager value fails the hook, and later reads throw the same error', async () => {
    const w = createWorld()
    const boom = new Error('boom')
    const outcome = await w.runFile('a.test.ts', () => {
      w.lazy.eager('db', async () => {
        throw boom
      })
      w.test('t', () => {})
    })
    assert.equal(outcome.tests[0]?.error, boom)
  })

  test('a rejection the eager hook awaits is flagged on the log, with its chain', async () => {
    // The hook awaits the value itself, so Provino sees this rejection (a lazy value's promise
    // that only the test awaits is not flagged: read.test.ts).
    const w = createWorld()
    const boom = new Error('boom')
    await w.runFile('a.test.ts', () => {
      w.lazy.eager('db', async () => {
        throw boom
      })
      w.test('t', () => {})
    })
    const run = w.runs[0]
    assert.ok(run)
    const log = w.runtime.evaluatedLazies(run)
    assert.deepEqual(
      log.map((e) => [e.key, e.failed, e.chain]),
      [['db', true, ['db']]],
    )
    assert.deepEqual(
      (boom as { [LAZY_CHAIN]?: { key: string }[] })[LAZY_CHAIN]?.map((m) => m.key),
      ['db'],
    )
  })

  test('a file-scoped eager value is evaluated in beforeAll', async () => {
    const w = createWorld()
    const order: string[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.eager(
          'db',
          async () => {
            order.push('eager')
            return 1
          },
          { scope: 'file' },
        )
        w.beforeEach(() => void order.push('beforeEach'))
        w.test('a', () => void $.db)
        w.test('b', () => void $.db)
      }),
    )
    assert.deepEqual(order, ['eager', 'beforeEach', 'beforeEach'])
  })

  test('re-declaring the key with lazy.let makes it lazy again', async () => {
    const w = createWorld()
    const seen: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.eager('db', async () => 'eager')
        w.describe('d', () => {
          const $d = $.let('db', () => 'lazy')
          w.test('t', () => void seen.push($d.db))
        })
      }),
    )
    assert.deepEqual(seen, ['lazy'])
  })
})
