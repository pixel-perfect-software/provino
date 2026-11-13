// The rebuilt Spikes C corpus (Track 6 §Spikes C): 30 behaviours of `@provino/lazy`, each run on the
// real `@provino/core` under one whole policy. The original `check.ts` was deleted with the spikes;
// this list is rebuilt from the behaviour table in the research. A behaviour passes when its function
// resolves, and fails with the assertion that broke.
import assert from 'node:assert/strict'
import { LazyError } from '@provino/lazy'
import type { LazyFrame, Policy } from '@provino/types'
import { type Env, type RunResult, runFile, runFiles } from './run.ts'

/** One behaviour: a name and what it checks under a policy. */
export interface Behaviour {
  readonly name: string
  readonly check: (policy: Policy) => Promise<void>
}

function passes(result: RunResult, name: string): void {
  const detail = (result.errors[name] ?? []).map((error) => error.message).join('; ')
  assert.equal(result.states[name], 'pass', `${name}: ${result.states[name]} ${detail}`)
}

function allPass(result: RunResult): void {
  assert.deepEqual(
    result.fileErrors.flat().map((error) => error.message),
    [],
  )
  const names = Object.keys(result.states)
  assert.ok(names.length > 0, 'no test ran')
  for (const name of names) passes(result, name)
}

function code(thrown: unknown): string | undefined {
  return thrown instanceof LazyError ? thrown.code : undefined
}

function attempt(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function frameOf(env: Env): Extract<LazyFrame, { kind: 'test' }> {
  const frame = env.runtime.lazyHost.current()
  assert.equal(frame?.kind, 'test')
  return frame as Extract<LazyFrame, { kind: 'test' }>
}

/** The fixed list. The runner multiplies it by the policies; the total must stay at 60 or more. */
export const BEHAVIOURS: readonly Behaviour[] = [
  {
    name: 'per-test memo, fresh for the next test',
    async check(policy) {
      let calls = 0
      const seen: number[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('n', () => ++calls)
        api.test('a', () => void seen.push($.n, $.n))
        api.test('b', () => void seen.push($.n))
      })
      allPass(result)
      assert.deepEqual(seen, [1, 1, 2])
    },
  },
  {
    name: 'late binding: a top-level value sees an override two levels down',
    async check(policy) {
      const seen: number[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('items', () => 2).let('total', ({ items }) => items * 6)
        api.test('top', () => void seen.push($.total))
        api.describe('a', () => {
          api.describe('b', () => {
            $.override('items', () => 3)
            api.test('deep', () => void seen.push($.total))
          })
        })
      })
      allPass(result)
      assert.deepEqual(seen, [12, 18])
    },
  },
  {
    name: 'parent() across two overrides and on a re-declare',
    async check(policy) {
      const seen: unknown[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('name', () => 'Ada').let('tier', () => 'basic')
        api.describe('a', () => {
          $.override('name', (_deps, { parent }) => `${parent()}!`)
          api.describe('b', () => {
            $.override('name', (_deps, { parent }) => `${parent()}?`)
            $.let(
              'tier',
              (_deps, ctx) => `${(ctx as unknown as { parent(): string }).parent()}+gold`,
            )
            api.test('t', () => void seen.push($.name, $.tier))
          })
        })
      })
      allPass(result)
      assert.deepEqual(seen, ['Ada!?', 'basic+gold'])
    },
  },
  {
    name: 'a top-level $ read in nested describes resolves from the test',
    async check(policy) {
      const seen: unknown[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('who', () => 'root')
        api.describe('a', () => {
          $.override('who', () => 'a')
          api.describe('b', () => {
            api.test('inherits a', () => void seen.push($.who))
          })
        })
        api.describe('c', () => {
          api.test('root', () => void seen.push($.who))
        })
      })
      allPass(result)
      assert.deepEqual(seen, ['a', 'root'])
    },
  },
  {
    name: 'eager runs at its position: before-1, eager, before-2',
    async check(policy) {
      const seen: unknown[] = []
      const result = await runFile(policy, ({ api, lazy, step }) => {
        api.beforeEach(() => step('before-1'))
        const $ = lazy.eager('db', async () => {
          step('eager')
          return { open: true }
        })
        api.beforeEach(() => {
          step('before-2')
          seen.push($.db)
        })
        api.test('t', () => void seen.push($.db))
      })
      allPass(result)
      assert.deepEqual(result.trace, ['before-1', 'eager', 'before-2'])
      assert.deepEqual(seen, [{ open: true }, { open: true }])
    },
  },
  {
    name: 'an earlier hook reading an eager value gets LAZY_EAGER_PENDING',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        let later: { readonly db: unknown } | undefined
        api.beforeEach(() => {
          thrown = attempt(() => later?.db)
        })
        later = lazy.eager('db', async () => 1)
        api.test('t', () => {})
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_EAGER_PENDING')
    },
  },
  {
    name: 'an in-flight promise is shared by concurrent readers',
    async check(policy) {
      let calls = 0
      let same = false
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('saved', async () => {
          calls++
          return 'x'
        })
        api.test('t', async () => {
          const readers = [$.saved, $.saved]
          same = readers[0] === readers[1]
          assert.deepEqual(await Promise.all(readers), ['x', 'x'])
        })
      })
      allPass(result)
      assert.equal(calls, 1)
      assert.equal(same, true)
    },
  },
  {
    name: 'a rejection is memoized',
    async check(policy) {
      let calls = 0
      const boom = new Error('boom')
      const caught: unknown[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('bad', async () => {
          calls++
          throw boom
        })
        api.test('t', async () => {
          for (let i = 0; i < 2; i++) caught.push(await $.bad.catch((error: unknown) => error))
        })
      })
      allPass(result)
      assert.equal(calls, 1)
      assert.deepEqual(caught, [boom, boom])
    },
  },
  {
    name: 'a sync throw is memoized',
    async check(policy) {
      let calls = 0
      const boom = new Error('boom')
      const caught: unknown[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('bad', () => {
          calls++
          throw boom
        })
        api.test('t', () => {
          for (let i = 0; i < 2; i++) caught.push(attempt(() => $.bad))
        })
      })
      allPass(result)
      assert.equal(calls, 1)
      assert.deepEqual(caught, [boom, boom])
    },
  },
  {
    name: 'three interleaved test.concurrent tests keep distinct, stable values',
    async check(policy) {
      let calls = 0
      const seen = new Map<string, number[]>()
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('n', () => ++calls)
        for (const name of ['a', 'b', 'c']) {
          api.test.concurrent(name, async () => {
            const first = $.n
            await new Promise((resolve) => setImmediate(resolve))
            seen.set(name, [first, $.n])
          })
        }
      })
      allPass(result)
      assert.equal(seen.size, 3)
      assert.equal(new Set([...seen.values()].map((pair) => pair[0])).size, 3)
      for (const [first, second] of seen.values()) assert.equal(first, second)
    },
  },
  {
    name: 'onCleanup runs last in first out after afterEach, on a failing test',
    async check(policy) {
      const result = await runFile(policy, ({ api, lazy, step }) => {
        const $ = lazy
          .let('a', (_deps, { onCleanup }) => {
            onCleanup(() => step('clean-a'))
            return 1
          })
          .let('b', (_deps, { onCleanup }) => {
            onCleanup(() => step('clean-b'))
            return 2
          })
          .let('c', (_deps, { onCleanup }) => {
            onCleanup(() => step('clean-c'))
            return 3
          })
        api.afterEach(() => step('afterEach'))
        api.test('t', () => {
          void ($.a + $.b + $.c)
          throw new Error('the test fails')
        })
      })
      assert.equal(result.states.t, 'fail')
      assert.deepEqual(result.trace, ['afterEach', 'clean-c', 'clean-b', 'clean-a'])
    },
  },
  {
    name: 'file and worker scopes over two files',
    async check(policy) {
      const files: Array<(env: Env) => void> = []
      for (let i = 0; i < 2; i++) {
        files.push(({ api, lazy, step }) => {
          // The same call site in both files, as a shared helper module has.
          const $ = defineScoped(lazy, step)
          api.test('a', () => void ($.f + $.g))
          api.test('b', () => void ($.f + $.g))
        })
      }
      const result = await runFiles(policy, files)
      allPass(result)
      assert.deepEqual(result.trace, [
        'f eval',
        'g eval',
        'f clean',
        'f eval',
        'f clean',
        'g clean',
      ])
    },
  },
  {
    name: 'a file value reading a test-scoped one: LAZY_SCOPE with both sites',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy
          .let('t', () => 1)
          .let('f', (deps) => (deps as { t: number }).t, { scope: 'file' })
        api.test('x', () => {
          thrown = attempt(() => $.f)
        })
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_SCOPE')
      assert.equal((thrown as LazyError).sites.length, 2)
    },
  },
  {
    name: 'reading a test-scoped value in beforeAll names the fix',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('user', () => 1)
        api.beforeAll(() => {
          thrown = attempt(() => $.user)
        })
        api.test('t', () => {})
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_SCOPE')
      assert.match(
        (thrown as Error).message,
        /test-scoped and cannot be read in beforeAll\. Read it in beforeEach, or declare it with \{ scope: 'file' \}/,
      )
    },
  },
  {
    name: 'a cycle names every definition',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        const view = (): Record<string, unknown> => chain as unknown as Record<string, unknown>
        const chain = lazy
          .let('x', () => view().y)
          .let('y', () => view().z)
          .let('z', () => view().x)
        api.test('t', () => {
          thrown = attempt(() => view().x)
        })
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_CYCLE')
      assert.match(
        (thrown as Error).message,
        /lazy cycle: `x` \(.*\) -> `y` \(.*\) -> `z` \(.*\) -> `x`/,
      )
    },
  },
  {
    name: 'a duplicate key throws LAZY_DUPLICATE with a site',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        lazy.let('user', () => 1)
        thrown = attempt(() => lazy.let('user', () => 2))
        api.test('t', () => {})
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_DUPLICATE')
      assert.match(String((thrown as LazyError).site?.file), /run\.ts$|behaviours\.ts$/)
    },
  },
  {
    name: 'an unknown override fails the file when it is collected',
    async check(policy) {
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('user', () => 1)
        api.describe('d', () => {
          $.override('usr' as never, (() => 2) as never)
          api.test('t', () => {})
        })
      })
      assert.ok(result.fileErrors.flat().some((error) => error.code === 'LAZY_INVALID'))
    },
  },
  {
    name: 'a file scope inside a describe throws LAZY_INVALID',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        api.describe('d', () => {
          thrown = attempt(() => lazy.let('db', () => 1, { scope: 'file' }))
          api.test('t', () => {})
        })
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_INVALID')
    },
  },
  {
    name: 'a reserved key throws LAZY_RESERVED',
    async check(policy) {
      const thrown: unknown[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        for (const key of ['then', 'let', 'toJSON'] as const) {
          thrown.push(attempt(() => lazy.let(key as 'x', () => 1)))
        }
        api.test('t', () => {})
      })
      allPass(result)
      assert.deepEqual(thrown.map(code), ['LAZY_RESERVED', 'LAZY_RESERVED', 'LAZY_RESERVED'])
    },
  },
  {
    name: '$.from(ctx) reads without an async context',
    async check(policy) {
      let ctx: object | undefined
      let $: { from(ctx: object): { readonly a: number; readonly b: number } } | undefined
      const result = await runFile(policy, ({ api, lazy }) => {
        const handle = lazy.let('a', () => 1).let('b', ({ a }) => a + 1)
        $ = handle as never
        api.test('t', () => {
          void handle.a
          api.onTestFinished((context) => {
            ctx = context
          })
        })
      })
      allPass(result)
      assert.ok(ctx !== undefined && $ !== undefined)
      const view = $.from(ctx)
      assert.equal(view.a, 1)
      assert.equal(view.b, 2)
      assert.equal(code(attempt(() => $?.from({}))), 'LAZY_BAD_CONTEXT')
    },
  },
  {
    name: 'a read outside a test throws LAZY_NO_TEST',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('a', () => 1)
        thrown = attempt(() => $.a)
        api.test('t', () => {})
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_NO_TEST')
    },
  },
  {
    name: 'await $ resolves to the handle',
    async check(policy) {
      let same = false
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('a', () => 1)
        api.test('t', async () => {
          same = (await $) === $
        })
      })
      allPass(result)
      assert.equal(same, true)
    },
  },
  {
    name: 'the failure report lists each evaluated lazy',
    async check(policy) {
      let log: ReturnType<RunResult['lazyRuntime']['evaluatedLazies']> = []
      const result = await runFile(policy, (env) => {
        const $ = env.lazy.let('a', () => 1).let('b', ({ a }) => a + 1)
        env.api.describe('d', () => {
          $.override('a', () => 5)
          env.api.test('t', () => {
            void $.b
            log = env.lazyRuntime.evaluatedLazies(frameOf(env).run)
          })
        })
      })
      allPass(result)
      assert.deepEqual(
        log.map((entry) => [entry.key, entry.override]),
        [
          ['a', true],
          ['b', false],
        ],
      )
      assert.ok(log.every((entry) => entry.site.line > 0 && entry.ms >= 0))
    },
  },
  {
    name: 'hooks and the body share one memo',
    async check(policy) {
      let calls = 0
      const seen: number[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('n', () => ++calls)
        api.beforeEach(() => void seen.push($.n))
        api.test('t', () => void seen.push($.n))
        api.afterEach(() => void seen.push($.n))
      })
      allPass(result)
      assert.deepEqual(seen, [1, 1, 1])
      assert.equal(calls, 1)
    },
  },
  {
    name: 'a retry gets a fresh memo',
    async check(policy) {
      let calls = 0
      const seen: number[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('n', () => ++calls)
        api.test('t', { retry: 1 }, () => {
          seen.push($.n)
          if (seen.length === 1) throw new Error('first attempt fails')
        })
      })
      allPass(result)
      assert.deepEqual(seen, [1, 2])
    },
  },
  {
    name: 'inspect, toJSON and toString read nothing',
    async check(policy) {
      const { inspect } = await import('node:util')
      let calls = 0
      const printed: string[] = []
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('user', () => 'Ada').let('cart', () => ++calls)
        api.test('t', () => {
          void $.user
          printed.push(inspect($), JSON.stringify($), String($))
        })
      })
      allPass(result)
      assert.equal(calls, 0)
      assert.deepEqual(printed, [
        "Lazy { user: 'Ada', cart: <lazy> }",
        '{"lazy":["user","cart"]}',
        '[object Lazy]',
      ])
    },
  },
  {
    name: 'the first read during cleanup throws LAZY_IN_CLEANUP',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, (env) => {
        const $ = env.lazy.let('late', () => 1)
        env.api.test('t', () => {
          frameOf(env).run.addTeardown(() => {
            thrown = attempt(() => $.late)
          })
        })
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_IN_CLEANUP')
    },
  },
  {
    name: 'a definition inside a test throws LAZY_NOT_COLLECTING',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        api.test('t', () => {
          thrown = attempt(() => lazy.let('a', () => 1))
        })
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_NOT_COLLECTING')
    },
  },
  {
    name: 'assigning to a key throws LAZY_READONLY',
    async check(policy) {
      let thrown: unknown
      const result = await runFile(policy, ({ api, lazy }) => {
        const $ = lazy.let('a', () => 1)
        api.test('t', () => {
          thrown = attempt(() => {
            ;($ as { a: number }).a = 2
          })
        })
      })
      allPass(result)
      assert.equal(code(thrown), 'LAZY_READONLY')
    },
  },
  {
    name: 'a shared group adds a key and reads the caller override (T6.7)',
    async check(policy) {
      const seen: unknown[] = []
      const result = await runFile(policy, ({ api, lazy, lazyRuntime }) => {
        const group = lazyRuntime.sharedExamples<{ subject: number }, [label: string]>(
          'a number',
          ($, label) => {
            const $g = $.let('double', ({ subject }) => subject * 2)
            api.test(`${label} doubles`, () => void seen.push(label, $g.subject, $g.double))
          },
        )
        const $ = lazy.let('subject', () => 1)
        lazyRuntime.itBehavesLike(group, $, 'plain')
        api.describe('over', () => {
          $.override('subject', () => 5)
          lazyRuntime.itBehavesLike(group, $, 'big')
        })
      })
      allPass(result)
      assert.deepEqual(seen, ['plain', 1, 2, 'big', 5, 10])
    },
  },
]

/** One call site both files of the two-file behaviour use: a file value and a worker value. */
function defineScoped(
  lazy: Env['lazy'],
  step: (name: string) => void,
): { readonly f: number; readonly g: number } {
  return lazy
    .let(
      'f',
      (_deps, { onCleanup }) => {
        step('f eval')
        onCleanup(() => step('f clean'))
        return 1
      },
      { scope: 'file' },
    )
    .let(
      'g',
      (_deps, { onCleanup }) => {
        step('g eval')
        onCleanup(() => step('g clean'))
        return 2
      },
      { scope: 'worker' },
    )
}
