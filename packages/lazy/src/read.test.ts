// T6.5: reads. Resolution from the innermost suite, memoization per run, async and error values,
// `parent()`, cycles and the read-time errors.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LazyError } from './errors.ts'
import { createWorld, type FileOutcome } from './internal/test-support.ts'

function passed(outcome: FileOutcome): void {
  assert.equal(outcome.collectError, undefined)
  assert.equal(outcome.teardownError, undefined)
  for (const t of outcome.tests) assert.equal(t.error, undefined, `${t.name}: ${String(t.error)}`)
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof LazyError ? error.code : `other: ${String(error)}`
  }
  return undefined
}

describe('memo', () => {
  test('a value is evaluated once per test, shared by hooks and body, fresh for the next test', async () => {
    const w = createWorld()
    let calls = 0
    const seen: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('n', () => ++calls)
        w.beforeEach(() => void seen.push($.n))
        w.test('one', () => void seen.push($.n, $.n))
        w.test('two', () => void seen.push($.n))
      }),
    )
    assert.deepEqual(seen, [1, 1, 1, 2, 2])
    assert.equal(calls, 2)
  })

  test('a retry gets a fresh memo', async () => {
    const w = createWorld()
    let calls = 0
    const seen: number[] = []
    const outcome = await w.runFile('a.test.ts', () => {
      const $ = w.lazy.let('n', () => ++calls)
      w.test(
        't',
        () => {
          seen.push($.n)
          if (seen.length === 1) throw new Error('first attempt fails')
        },
        { retry: 1 },
      )
    })
    passed(outcome)
    assert.deepEqual(seen, [1, 2])
  })

  test('three concurrent tests each get their own stable value', async () => {
    const w = createWorld()
    let calls = 0
    const seen = new Map<string, number[]>()
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('n', () => ++calls)
        for (const name of ['a', 'b', 'c']) {
          w.test(
            name,
            async () => {
              const first = $.n
              await new Promise((resolve) => setImmediate(resolve))
              seen.set(name, [first, $.n])
            },
            { concurrent: true },
          )
        }
      }),
    )
    const values = [...seen.values()]
    assert.equal(new Set(values.map((v) => v[0])).size, 3)
    for (const [first, second] of values) assert.equal(first, second)
  })
})

describe('resolution', () => {
  test('a definition at the top sees an override two levels down (late binding)', async () => {
    const w = createWorld()
    const totals: number[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('items', () => 1).let('total', ({ items }) => items * 10)
        w.test('top', () => void totals.push($.total))
        w.describe('a', () => {
          w.describe('b', () => {
            $.override('items', () => 2)
            w.test('deep', () => void totals.push($.total))
          })
          w.test('middle', () => void totals.push($.total))
        })
      }),
    )
    assert.deepEqual(totals, [10, 20, 10])
  })

  test('parent() resolves outward across two overrides and on a re-declare', async () => {
    const w = createWorld()
    const seen: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('name', () => 'Ada').let('tier', () => 'basic')
        w.describe('a', () => {
          $.override('name', (_d, { parent }) => `${parent()}!`)
          w.describe('b', () => {
            $.override('name', (_d, { parent }) => `${parent()}?`)
            $.let('tier', (_d, ctx) => `${(ctx as unknown as { parent(): string }).parent()}+gold`)
            w.test('t', () => void seen.push($.name, $.tier))
          })
        })
      }),
    )
    assert.deepEqual(seen, ['Ada!?', 'basic+gold'])
  })

  test('a key no suite around the test defines throws LAZY_UNDEFINED', async () => {
    const w = createWorld()
    const codes: Array<string | undefined> = []
    let $: { readonly a: number } | undefined
    passed(
      await w.runFile('a.test.ts', () => {
        w.describe('x', () => {
          $ = w.lazy.let('a', () => 1)
        })
        w.test('t', () => void codes.push(codeOf(() => $?.a)))
      }),
    )
    assert.deepEqual(codes, ['LAZY_UNDEFINED'])
  })

  test('a definition reads others through deps', async () => {
    const w = createWorld()
    let got: unknown
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('a', () => 2).let('b', ({ a }) => a + 1)
        w.test('t', () => {
          got = $.b
        })
      }),
    )
    assert.equal(got, 3)
  })
})

describe('async and errors', () => {
  test('concurrent readers share the in-flight promise, and the value is evaluated once', async () => {
    const w = createWorld()
    let calls = 0
    const promises: Array<Promise<unknown>> = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('saved', async () => {
          calls++
          return 'x'
        })
        w.test('t', async () => {
          promises.push($.saved, $.saved)
          assert.deepEqual(await Promise.all(promises), ['x', 'x'])
        })
      }),
    )
    assert.equal(calls, 1)
    assert.equal(promises[0], promises[1])
  })

  test('a rejection and a sync throw are memoized: one evaluation, the same error', async () => {
    const w = createWorld()
    let rejections = 0
    let throws = 0
    const boom = new Error('boom')
    const results: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy
          .let('rejected', async () => {
            rejections++
            throw boom
          })
          .let('thrown', () => {
            throws++
            throw boom
          })
        w.test('t', async () => {
          for (let i = 0; i < 2; i++) {
            results.push(await $.rejected.catch((e: unknown) => e))
            try {
              $.thrown
            } catch (error) {
              results.push(error)
            }
          }
        })
      }),
    )
    assert.equal(rejections, 1)
    assert.equal(throws, 1)
    for (const r of results) assert.equal(r, boom)
  })

  test('await $ resolves to the handle, which is not thenable', async () => {
    const w = createWorld()
    let same = false
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('a', () => 1)
        w.test('t', async () => {
          same = (await $) === $
        })
      }),
    )
    assert.equal(same, true)
  })
})

describe('read-time errors', () => {
  test('a cycle throws LAZY_CYCLE naming every definition, through deps or through $', async () => {
    const w = createWorld()
    const messages: string[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const view = (): Record<string, unknown> => chain as unknown as Record<string, unknown>
        const chain = w.lazy
          .let('x', (d) => (d as Record<string, unknown>).y)
          .let('y', (d) => (d as Record<string, unknown>).z)
          .let('z', (d) => (d as Record<string, unknown>).x)
          .let('p', () => view().q)
          .let('q', () => view().p)
        w.test('deps', () => {
          try {
            view().x
          } catch (error) {
            assert.ok(error instanceof LazyError)
            assert.equal(error.code, 'LAZY_CYCLE')
            messages.push(error.message)
            assert.equal(error.sites.length, 4)
          }
        })
        w.test('dollar', () => {
          try {
            view().p
          } catch (error) {
            assert.equal((error as LazyError).code, 'LAZY_CYCLE')
            messages.push((error as LazyError).message)
          }
        })
      }),
    )
    assert.match(messages[0] ?? '', /lazy cycle: `x` \(.*\) -> `y` \(.*\) -> `z` \(.*\) -> `x`/)
    assert.match(messages[1] ?? '', /`p` .* -> `q` .* -> `p`/)
  })

  test('reading outside a test throws LAZY_NO_TEST, and $.from(ctx) works without a frame', async () => {
    const w = createWorld()
    const codes: Array<string | undefined> = []
    let $: { readonly a: number; from(ctx: object): { readonly a: number } } | undefined
    let ctx: object | undefined
    passed(
      await w.runFile('a.test.ts', () => {
        $ = w.lazy.let('a', () => 5) as never
        codes.push(codeOf(() => $?.a))
        w.test('t', (c) => {
          ctx = c
        })
      }),
    )
    codes.push(codeOf(() => $?.a))
    const fromValue = $?.from(ctx as object).a
    assert.deepEqual(codes, ['LAZY_NO_TEST', 'LAZY_NO_TEST'])
    assert.equal(fromValue, 5)
    assert.equal(
      codeOf(() => $?.from({})),
      'LAZY_BAD_CONTEXT',
    )
  })

  test('the first read during cleanup throws LAZY_IN_CLEANUP; an earlier read is still readable', async () => {
    const w = createWorld()
    const codes: Array<string | undefined> = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('early', () => 1).let('late', () => 2)
        w.test('t', (ctx) => {
          void $.early
          const run = w.host.runOf(ctx)
          run?.addTeardown(() => {
            codes.push(
              codeOf(() => $.late),
              codeOf(() => $.early),
            )
          })
        })
      }),
    )
    assert.deepEqual(codes, ['LAZY_IN_CLEANUP', undefined])
  })

  test('assigning to a key throws LAZY_READONLY', async () => {
    const w = createWorld()
    const codes: Array<string | undefined> = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('a', () => 1)
        w.test('t', () => {
          codes.push(codeOf(() => (($ as { a: number }).a = 2)))
        })
      }),
    )
    assert.deepEqual(codes, ['LAZY_READONLY'])
  })
})

describe('the evaluation log', () => {
  test('lists each evaluated lazy with its site and override marker, dependencies first', async () => {
    const w = createWorld()
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.let('a', () => 1).let('b', ({ a }) => a)
        w.describe('d', () => {
          $.override('a', () => 2)
          w.test('t', () => void $.b)
        })
      }),
    )
    const run = w.runs[0]
    assert.ok(run)
    const log = w.runtime.evaluatedLazies(run)
    assert.deepEqual(
      log.map((e) => [e.key, e.override]),
      [
        ['a', true],
        ['b', false],
      ],
    )
    assert.match(log[0]?.site.file ?? '', /read\.test\.ts$/)
    assert.ok((log[0]?.ms ?? -1) >= 0)
  })
})
