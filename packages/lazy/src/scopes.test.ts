// Scopes and cleanup: file and worker values over two files, scope violations, `onCleanup` order
// and `LetOptions.timeout`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LazyError } from './errors.ts'
import { createWorld, type FileOutcome } from './internal/test-support.ts'

function passed(outcome: FileOutcome): void {
  assert.equal(outcome.collectError, undefined)
  assert.equal(outcome.teardownError, undefined)
  for (const t of outcome.tests) assert.equal(t.error, undefined, `${t.name}: ${String(t.error)}`)
}

describe('file and worker scopes', () => {
  test('a file value is evaluated once per file, a worker value once per worker, cleaned up at their ends', async () => {
    const w = createWorld()
    const events: string[] = []
    // The same call site in two files, as a shared helper module would have.
    function define(): { readonly f: number; readonly g: number } {
      return w.lazy
        .let(
          'f',
          (_d, { onCleanup }) => {
            events.push('f eval')
            onCleanup(() => void events.push('f clean'))
            return 1
          },
          { scope: 'file' },
        )
        .let(
          'g',
          (_d, { onCleanup }) => {
            events.push('g eval')
            onCleanup(() => void events.push('g clean'))
            return 2
          },
          { scope: 'worker' },
        )
    }
    for (const name of ['one.test.ts', 'two.test.ts']) {
      passed(
        await w.runFile(name, () => {
          const $ = define()
          w.test('a', () => void ($.f + $.g))
          w.test('b', () => void ($.f + $.g))
        }),
      )
      events.push(`end ${name}`)
    }
    await w.dispose()
    assert.deepEqual(events, [
      'f eval',
      'g eval',
      'f clean',
      'end one.test.ts',
      'f eval',
      'f clean',
      'end two.test.ts',
      'g clean',
    ])
  })

  test('a file value reading a test-scoped one throws LAZY_SCOPE with both sites', async () => {
    const w = createWorld()
    let error: unknown
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy
          .let('t', () => 1)
          .let('f', (d) => (d as { t: number }).t, { scope: 'file' })
        w.test('x', () => {
          try {
            $.f
          } catch (thrown) {
            error = thrown
          }
        })
      }),
    )
    assert.ok(error instanceof LazyError)
    assert.equal(error.code, 'LAZY_SCOPE')
    assert.equal(error.sites.length, 2)
    assert.match(error.message, /`f` .* scope 'file' .* `t` .* narrower scope 'test'/)
  })

  test('a worker value reading a file-scoped one throws LAZY_SCOPE', async () => {
    const w = createWorld()
    let error: unknown
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy
          .let('f', () => 1, { scope: 'file' })
          .let('g', (d) => (d as { f: number }).f, { scope: 'worker' })
        w.test('x', () => {
          try {
            $.g
          } catch (thrown) {
            error = thrown
          }
        })
      }),
    )
    assert.equal((error as LazyError).code, 'LAZY_SCOPE')
  })

  test('a file value is readable in beforeAll, and its task is undefined', async () => {
    const w = createWorld()
    let seen: unknown
    let task: unknown = 'unset'
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let(
          'f',
          (_d, ctx) => {
            task = ctx.task
            return 'file value'
          },
          { scope: 'file' },
        )
        w.beforeAll(() => {
          seen = $.f
        })
        w.test('t', () => {})
      }),
    )
    assert.equal(seen, 'file value')
    assert.equal(task, undefined)
  })

  test('a worker value is memoized across files even when its definition site is shared', async () => {
    const w = createWorld()
    let calls = 0
    const define = () => w.lazy.let('g', () => ++calls, { scope: 'worker' })
    for (const name of ['one.test.ts', 'two.test.ts', 'three.test.ts']) {
      passed(
        await w.runFile(name, () => {
          const $ = define()
          w.test('t', () => void $.g)
        }),
      )
    }
    assert.equal(calls, 1)
  })
})

describe('cleanup', () => {
  test('onCleanup runs last in first out, after afterEach, even when the test fails', async () => {
    const w = createWorld()
    const order: string[] = []
    const outcome = await w.runFile('a.test.ts', () => {
      const $ = w.lazy
        .let('a', (_d, { onCleanup }) => {
          onCleanup(() => void order.push('a'))
          return 1
        })
        .let('b', (_d, { onCleanup }) => {
          onCleanup(() => void order.push('b'))
          return 2
        })
        .let('c', (_d, { onCleanup }) => {
          onCleanup(() => void order.push('c'))
          return 3
        })
      w.afterEach(() => void order.push('afterEach'))
      w.test('t', () => {
        void ($.a + $.b + $.c)
        throw new Error('the test fails')
      })
    })
    assert.equal((outcome.tests[0]?.error as Error | undefined)?.message, 'the test fails')
    assert.deepEqual(order, ['afterEach', 'c', 'b', 'a'])
  })

  test('a value whose definition throws still runs the cleanups it registered', async () => {
    const w = createWorld()
    const order: string[] = []
    await w.runFile('a.test.ts', () => {
      const $ = w.lazy.let('a', (_d, { onCleanup }) => {
        onCleanup(() => void order.push('cleaned'))
        throw new Error('bad')
      })
      w.test('t', () => void $.a)
    })
    assert.deepEqual(order, ['cleaned'])
  })
})

describe('timeout', () => {
  test('an async definition that outlasts its timeout rejects with LAZY_TIMEOUT and aborts its signal', async () => {
    const w = createWorld()
    let aborted = false
    let error: unknown
    await w.runFile('a.test.ts', () => {
      const $ = w.lazy.let(
        'slow',
        (_d, { signal }) => {
          signal.addEventListener('abort', () => {
            aborted = true
          })
          return new Promise<number>(() => {})
        },
        { timeout: 5 },
      )
      w.test('t', async () => {
        try {
          await $.slow
        } catch (thrown) {
          error = thrown
        }
      })
    })
    assert.equal((error as LazyError).code, 'LAZY_TIMEOUT')
    assert.equal(aborted, true)
  })

  test('a definition that settles in time is not timed out', async () => {
    const w = createWorld()
    let got: unknown
    await w.runFile('a.test.ts', () => {
      const $ = w.lazy.let('fast', async () => 7, { timeout: 1000 })
      w.test('t', async () => {
        got = await $.fast
      })
    })
    assert.equal(got, 7)
  })
})
