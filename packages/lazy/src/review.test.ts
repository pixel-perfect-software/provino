// Pre-merge review regressions (PR #50): the definition site of the public root, keys named like
// the runtime's own fields, eager overrides of wider scopes, and where a nested eager runs.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  includeContext as publicIncludeContext,
  includeExamples as publicIncludeExamples,
  itBehavesLike as publicItBehavesLike,
  lazy as publicLazy,
} from './api.ts'
import { LazyError } from './errors.ts'
import { createWorld, type FileOutcome } from './internal/test-support.ts'
import { installLazyRuntime } from './slot.ts'

function passed(outcome: FileOutcome): void {
  assert.equal(outcome.collectError, undefined)
  for (const t of outcome.tests) assert.equal(t.error, undefined, `${t.name}: ${String(t.error)}`)
}

describe('the definition site of the public root', () => {
  test('is the caller of lazy.let, so worker values of one key in two files stay apart', async () => {
    const w = createWorld()
    const uninstall = installLazyRuntime({ lazy: w.lazy } as never)
    try {
      const seen: unknown[] = []
      passed(
        await w.runFile('a.test.ts', () => {
          const $ = publicLazy.let('db', () => 'postgres', { scope: 'worker' })
          w.test('t', () => void seen.push($.db))
        }),
      )
      passed(
        await w.runFile('b.test.ts', () => {
          const $ = publicLazy.let('db', () => 'redis', { scope: 'worker' })
          w.test('t', () => void seen.push($.db))
        }),
      )
      assert.deepEqual(seen, ['postgres', 'redis'])
    } finally {
      uninstall()
    }
  })

  test('is in the user file for a duplicate through the root', async () => {
    const w = createWorld()
    const uninstall = installLazyRuntime({ lazy: w.lazy } as never)
    try {
      const outcome = await w.runFile('a.test.ts', () => {
        publicLazy.let('x', () => 1)
        publicLazy.eager('y', () => 1)
        try {
          publicLazy.let('x', () => 2)
        } catch (error) {
          assert.ok(error instanceof LazyError)
          for (const s of error.sites) assert.match(s.file, /review\.test\.ts$/)
          assert.match(error.site?.file ?? '', /review\.test\.ts$/)
          return
        }
        assert.fail('no duplicate')
      })
      assert.equal(outcome.collectError, undefined)
    } finally {
      uninstall()
    }
  })
})

describe('keys named like the runtime internals', () => {
  test('suite, engine, frame and from read as lazy values through deps, $ and $.from(ctx)', async () => {
    const w = createWorld()
    const seen: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy
          .let('suite', () => 'checkout')
          .let('engine', () => 'v8')
          .let('frame', () => 'f')
          .let('label', (d) => [d.suite, d.engine, d.frame])
        w.test('t', (ctx) => {
          const v = $.from(ctx as never) as Record<string, unknown>
          seen.push($.suite, $.engine, $.frame, $.label, v.suite, v.engine, v.frame, v.label)
        })
      }),
    )
    assert.deepEqual(seen, [
      'checkout',
      'v8',
      'f',
      ['checkout', 'v8', 'f'],
      'checkout',
      'v8',
      'f',
      ['checkout', 'v8', 'f'],
    ])
  })
})

describe('eager overrides of wider scopes', () => {
  for (const scope of ['file', 'worker'] as const) {
    test(`an override of a ${scope}-scoped eager key in a describe is evaluated before its tests`, async () => {
      const w = createWorld()
      const seen: unknown[] = []
      passed(
        await w.runFile('a.test.ts', () => {
          const $ = w.lazy.eager('db', async () => 'root', { scope })
          w.test('outer', () => void seen.push($.db))
          w.describe('d', () => {
            $.override('db', async () => 'nested')
            w.test('t', () => void seen.push($.db))
          })
        }),
      )
      assert.deepEqual(seen, ['root', 'nested'])
    })
  }
})

describe('a nested eager re-declare', () => {
  test('runs at its own position, after the describe’s earlier beforeEach', async () => {
    const w = createWorld()
    const trace: string[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.lazy.eager('db', async () => {
          trace.push('root eager')
          return 1
        })
        w.describe('d', () => {
          w.beforeEach(() => void trace.push('d before'))
          $.eager('db', async () => {
            trace.push('nested eager')
            return 2
          })
          w.test('t', () => void trace.push('test'))
        })
      }),
    )
    assert.deepEqual(trace, ['d before', 'nested eager', 'test'])
  })
})

describe('shared groups through the public functions', () => {
  test('a misuse is sited at the caller, not at api.ts', async () => {
    const w = createWorld()
    const uninstall = installLazyRuntime(w.runtime as never)
    try {
      const group = w.runtime.sharedExamples<{ n: number }>('n', () => {})
      const context = w.runtime.sharedContext<{ n: number }, { m: number }>('m', ($) => $ as never)
      const thrown: unknown[] = []
      passed(
        await w.runFile('a.test.ts', () => {
          const $ = w.lazy.let('n', () => 1)
          w.test('t', () => {
            for (const fn of [
              () => publicIncludeExamples(group, $),
              () => publicItBehavesLike(group, $),
              () => publicIncludeContext($, context as never),
            ]) {
              try {
                fn()
              } catch (error) {
                thrown.push(error)
              }
            }
          })
        }),
      )
      assert.equal(thrown.length, 3)
      for (const error of thrown) {
        assert.ok(error instanceof LazyError)
        assert.equal(error.code, 'LAZY_NOT_COLLECTING')
        assert.match(error.site?.file ?? '', /review\.test\.ts$/)
      }
    } finally {
      uninstall()
    }
  })

  test('a context body that returns no handle names the includeContext call site', async () => {
    const w = createWorld()
    const uninstall = installLazyRuntime(w.runtime as never)
    try {
      const context = w.runtime.sharedContext('bad', (() => 1) as never)
      const outcome = await w.runFile('a.test.ts', () => {
        publicIncludeContext(
          w.lazy.let('n', () => 1),
          context as never,
        )
      })
      assert.ok(outcome.collectError instanceof LazyError)
      assert.match(outcome.collectError.message, /review\.test\.ts:\d+:\d+\)/)
    } finally {
      uninstall()
    }
  })

  test('definitions made inside a group body keep their own site', async () => {
    const w = createWorld()
    const uninstall = installLazyRuntime(w.runtime as never)
    try {
      const group = w.runtime.sharedExamples<{ n: number }>('n', ($) => {
        try {
          $.let('d', () => 1).let('d', () => 2)
        } catch (error) {
          assert.ok(error instanceof LazyError)
          assert.match(error.site?.file ?? '', /review\.test\.ts$/)
          w.test('ran', () => {})
          return
        }
        assert.fail('no duplicate')
      })
      const outcome = await w.runFile('a.test.ts', () => {
        publicIncludeExamples(
          group,
          w.lazy.let('n', () => 1),
        )
      })
      passed(outcome)
      assert.equal(outcome.tests.length, 1)
    } finally {
      uninstall()
    }
  })

  test('keys named suite, engine and frame work through a context and its returned handle', async () => {
    const w = createWorld()
    const context = w.runtime.sharedContext<{ n: number }, { suite: string; engine: string }>(
      'names',
      ($) => $.let('suite', () => 'checkout').let('engine', ({ n }) => `v${n}`) as never,
    )
    const seen: unknown[] = []
    passed(
      await w.runFile('a.test.ts', () => {
        const $ = w.runtime.includeContext(
          w.lazy.let('n', () => 8),
          context as never,
        ) as unknown as {
          suite: string
          engine: string
        }
        w.test('t', () => void seen.push($.suite, $.engine))
      }),
    )
    assert.deepEqual(seen, ['checkout', 'v8'])
  })
})
