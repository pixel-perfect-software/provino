// T5.9: the definition table's fixtures, through the real runtime under the neutral policy
// (`definitions.extendApi: 'expose'`, `definitions.messages: null`: core's own words). The Vitest
// side is held to Vitest 5.0.5's recordings by `@provino/harness`'s runtime corpus
// (`runtime/fixture-*`).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DefinitionErrorInfo } from '@provino/types'
import FakeTimers from '@sinonjs/fake-timers'
import type { FixtureTestApi } from '../collector/api.ts'
import { CoreError } from '../errors.ts'
import { clockOptions, runScript, type Script, settle } from '../internal/test-support.ts'
import { definitionError } from './errors.ts'
import { NO_WORDS } from './resolve.ts'
import { usedProps } from './used-props.ts'

type Use<V> = (value: V) => Promise<void>

/** The runtime's `test` with its fixture API, as the neutral policy exposes it. */
const fixtureTest = (api: Parameters<Script>[0]): FixtureTestApi => api.test as FixtureTestApi

const props = (fn: (...args: never[]) => unknown, index = 0): string[] => [
  ...usedProps(fn, NO_WORDS, { index }),
]

describe('usedProps', () => {
  test('reads the keys an object pattern names, defaults and renames included', () => {
    assert.deepEqual(
      props(({ a, b = 1, c: d }: Record<string, number>) => [a, b, d]),
      ['a', 'b', 'c'],
    )
    assert.deepEqual(
      props((_ctx: unknown, { x }: { x: number }) => x, 1),
      ['x'],
    )
    assert.deepEqual(
      props(() => 1),
      [],
    )
    assert.deepEqual(
      // biome-ignore lint/correctness/noEmptyPattern: an empty pattern is what is read
      props(({}: object) => 1),
      [],
    )
  })

  test('skips comments and reads a function lowered from async', () => {
    // biome-ignore lint/complexity/useArrowFunction: the source text is what is read
    const commented = function (/* { nope } */ { yes }: { yes: number }) {
      return yes
    }
    assert.deepEqual(props(commented), ['yes'])
    const lowered = new Function(
      'return function () { return __async(this, null, function* ({ db, user }) {}) }',
    )() as () => unknown
    assert.deepEqual(props(lowered), ['db', 'user'])
  })

  test('refuses a parameter that is not an object pattern, and a rest element', () => {
    assert.throws(
      () => props((context: unknown) => context),
      (error: unknown) =>
        error instanceof CoreError &&
        error.code === 'CORE_DEFINITION_PARSE' &&
        error.message.includes('"context"'),
    )
    assert.throws(
      () => props(({ a, ...rest }: Record<string, number>) => [a, rest]),
      (error: unknown) => error instanceof CoreError && error.message.includes('...rest'),
    )
  })
})

describe('definitionError', () => {
  const info: DefinitionErrorInfo = {
    kind: 'dependency',
    code: 'cycle',
    key: 'a',
    message: 'core words',
    params: { cycle: 'a <- b <- a' },
  }

  test('with no definitions.messages, a CoreError in core words, coded by kind', () => {
    const error = definitionError(NO_WORDS, info)
    assert.ok(error instanceof CoreError)
    assert.equal(error.code, 'CORE_DEFINITION_DEPENDENCY')
    assert.equal(error.message, 'core words')
  })

  test("with a formatter, its name and message, and the kind's code kept off the enumerable keys", () => {
    const error = definitionError(
      { format: (e) => ({ name: 'FixtureDependencyError', message: `cycle ${e.params.cycle}` }) },
      info,
    )
    assert.equal(error.name, 'FixtureDependencyError')
    assert.equal(error.message, 'cycle a <- b <- a')
    assert.equal((error as Error & { code?: string }).code, 'CORE_DEFINITION_DEPENDENCY')
    assert.ok(!Object.keys(error).includes('code'))
  })
})

describe('test.extend', () => {
  test('the object form: values, use() fixtures, a dependency, a fresh value per test', async () => {
    const run = await runScript((api, step) => {
      const it = fixtureTest(api).extend<{ answer: number; list: number[]; doubled: number[] }>({
        answer: 42,
        list: async ({ task: _task }, use: Use<number[]>) => {
          step('list setup')
          await use([1, 2])
          step('list teardown')
        },
        doubled: async ({ list }: { list: number[] }, use: Use<number[]>) => {
          await use(list.map((n) => n * 2))
        },
      })
      it('reads', ({ answer, doubled }) => step(`${answer} ${doubled.join(',')}`))
      it('changes', ({ list }) => {
        list.push(3)
      })
      it('fresh', ({ list }) => step(list.join(',')))
    })
    assert.deepEqual(run.trace, [
      'list setup',
      '42 2,4',
      'list teardown',
      'list setup',
      'list teardown',
      'list setup',
      '1,2',
      'list teardown',
    ])
    assert.deepEqual(Object.values(run.states), ['pass', 'pass', 'pass'])
  })

  test('the builder form and onCleanup; a file value is built once', async () => {
    const run = await runScript((api, step) => {
      const it = fixtureTest(api)
        .extend('base', () => 1)
        .extend('plus', ({ base }) => base + 1)
        .extend('file', { scope: 'file' }, ({ task: _task }, { onCleanup }) => {
          step('file built')
          onCleanup(() => step('file cleanup'))
          return 'f'
        })
      it('one', ({ plus, file }) => step(`${plus} ${file}`))
      it('two', ({ file }) => step(file))
    })
    assert.deepEqual(run.trace, ['file built', '2 f', 'f', 'file cleanup'])
  })

  test('auto fixtures run before beforeEach; cleanups follow afterEach, dependents first', async () => {
    const run = await runScript((api, step) => {
      const it = fixtureTest(api).extend<{ auto: undefined; a: string; b: string }>({
        auto: [
          async ({ task: _task }, use: Use<undefined>) => {
            step('auto')
            await use(undefined)
          },
          { auto: true },
        ],
        a: async ({ task: _task }, use: Use<string>) => {
          await use('a')
          step('a down')
        },
        b: async ({ a }: { a: string }, use: Use<string>) => {
          await use(`${a}b`)
          step('b down')
        },
      })
      api.beforeEach(() => step('beforeEach'))
      api.afterEach(() => step('afterEach'))
      it('t', ({ b, onTestFinished }) => {
        onTestFinished(() => step('finished'))
        step(b)
      })
    })
    assert.deepEqual(run.trace, [
      'auto',
      'beforeEach',
      'ab',
      'afterEach',
      'b down',
      'a down',
      'finished',
    ])
  })

  test('test.override in a describe reads the parent and reaches dependents there only', async () => {
    const run = await runScript((api, step) => {
      const it = fixtureTest(api).extend<{ user: string; hello: string }>({
        user: 'base',
        hello: async ({ user }: { user: string }, use: Use<string>) => use(`hi ${user}`),
      })
      api.describe('inner', () => {
        it.override('user', ({ user }) => `${user}+`)
        it('over', ({ hello }) => step(hello))
      })
      it('outer', ({ hello }) => step(hello))
    })
    assert.deepEqual(run.trace, ['hi base+', 'hi base'])
  })

  test('test.beforeAll gets file fixtures; a plain one that destructures fails', async () => {
    const run = await runScript(
      (api, step) => {
        const it = fixtureTest(api).extend<{ shared: string; perTest: string }>({
          shared: ['s', { scope: 'file' }],
          perTest: 't',
        })
        api.describe('file', () => {
          it.beforeAll(({ shared }) => step(`beforeAll ${shared}`))
          it('runs', () => step('ran'))
        })
        api.describe('test scoped', () => {
          it.beforeAll(({ perTest }) => step(`never ${perTest}`))
          it('skipped', () => step('never'))
        })
        api.describe('plain', () => {
          api.beforeAll((({ shared }: { shared: string }) => step(`never ${shared}`)) as never)
          it('skipped too', () => step('never'))
        })
      },
      // Vitest's refusal of a plain suite hook that destructures (`definitions.plainSuiteHook`).
      { definitions: { plainSuiteHook: 'refuse-fixtures' } },
    )
    assert.deepEqual(run.trace, ['beforeAll s', 'ran'])
    const errors = (path: string) => [
      ...(run.suites[path]?.errors.map((e) => e.message) ?? []),
      ...Object.entries(run.errors).flatMap(([name, list]) => (name.startsWith(path) ? list : [])),
    ]
    assert.match(errors('test scoped')[0] ?? '', /test-scoped definitions \("perTest"\)/)
    assert.match(errors('plain')[0] ?? '', /has no definitions to read/)
  })

  test('a cycle, and a fixture that never calls use, fail their test', async () => {
    const run = await runScript((api) => {
      const it = fixtureTest(api).extend<{ ping: string; pong: string; noUse: string }>({
        ping: async ({ pong }: { pong: string }, use: Use<string>) => use(pong),
        pong: async ({ ping }: { ping: string }, use: Use<string>) => use(ping),
        noUse: async () => undefined,
      })
      it('cycle', ({ ping }) => ping)
      it('no use', ({ noUse }) => noUse)
    })
    assert.match(run.errors.cycle?.[0] ?? '', /cycle: ping <- pong <- ping/)
    assert.match(run.errors['no use']?.[0] ?? '', /"noUse" returned without calling use/)
  })

  test('registration errors: a narrower dependency, a scope inside a describe, an unknown key', async () => {
    const errors: unknown[] = []
    await runScript((api) => {
      const base = fixtureTest(api)
      const attempt = (fn: () => unknown) => {
        try {
          fn()
        } catch (error) {
          errors.push(error)
        }
      }
      attempt(() =>
        base.extend({
          t: 1,
          f: [async ({ t }: { t: number }, use: Use<number>) => use(t), { scope: 'file' }],
        }),
      )
      attempt(() =>
        // An unknown key is a type error too; the runtime's check is what this holds.
        base.extend({
          missing: async ({ nope }: { nope: number }, use: Use<number>) => use(nope),
        } as never),
      )
      api.describe('d', () => {
        attempt(() => base.extend({ w: [1, { scope: 'worker' }] }))
      })
      base('t', () => undefined)
    })
    assert.deepEqual(
      errors.map((e) => (e instanceof CoreError ? e.code : String(e))),
      ['CORE_DEFINITION_DEPENDENCY', 'CORE_DEFINITION_DEPENDENCY', 'CORE_DEFINITION_DEPENDENCY'],
    )
    assert.match((errors[0] as Error).message, /cannot read "t", whose scope "test" is narrower/)
  })

  test('worker fixtures clean up when the runtime is disposed', async () => {
    const trace: string[] = []
    const run = await runScript((api) => {
      const it = fixtureTest(api).extend<{ w: number }>({
        w: [
          async ({ task: _task }, use: Use<number>) => {
            await use(1)
            trace.push('worker down')
          },
          { scope: 'worker' },
        ],
      })
      it('t', ({ w }) => trace.push(`w ${w}`))
    })
    assert.deepEqual(trace, ['w 1'])
    await run.runtime.dispose()
    assert.deepEqual(trace, ['w 1', 'worker down'])
  })

  test("an injected fixture takes the runtime's value, else its default", async () => {
    const run = await runScript(
      (api, step) => {
        const it = fixtureTest(api).extend<{ given: string; kept: string }>({
          given: ['default', { injected: true }],
          kept: ['default', { injected: true }],
        })
        it('t', ({ given, kept }) => step(`${given} ${kept}`))
      },
      {},
      { injectValue: (key) => (key === 'given' ? 'provided' : undefined) },
    )
    assert.deepEqual(run.trace, ['provided default'])
  })

  test('under definitions.extendApi: absent, test has no extend or override (Jest)', async () => {
    const seen: string[] = []
    await runScript(
      (api) => {
        const it = api.test as Partial<FixtureTestApi>
        seen.push(typeof it.extend, typeof it.override)
        api.test('t', () => undefined)
      },
      { definitions: { extendApi: 'absent', messages: null } },
    )
    assert.deepEqual(seen, ['undefined', 'undefined'])
  })
})

describe('Vitest 5.0.5 parity (the review probes against the real runner)', () => {
  test('a dependency-free fixture function still joins the chain: the cycle is found through it', async () => {
    const run = await runScript((api) => {
      const base = fixtureTest(api).extend<{ a: string }>({
        // biome-ignore lint/correctness/noEmptyPattern: a fixture with no dependencies, as Vitest reads it
        a: async ({}, use: Use<string>) => use('a1'),
      })
      const swapped = base.extend({
        // biome-ignore lint/correctness/noEmptyPattern: a fixture with no dependencies, as Vitest reads it
        z: async ({}: object, use: Use<string>) => use('z'),
        b: async ({ a }: { a: string }, use: Use<string>) => use(`b:${a}`),
        a: async ({ z, b, a }: { z: string; b: string; a: string }, use: Use<string>) =>
          use(`${z}${b}${a}`),
      } as never) as FixtureTestApi<{ a: string }>
      swapped('swap', ({ a }) => a)
      const plain = fixtureTest(api).extend({
        // biome-ignore lint/correctness/noEmptyPattern: a fixture with no dependencies, as Vitest reads it
        b: async ({}: object, use: Use<string>) => use('b'),
        c: async ({ a }: { a: string }, use: Use<string>) => use(a),
        a: async ({ b, c }: { b: string; c: string }, use: Use<string>) => use(b + c),
      } as never) as FixtureTestApi<{ a: string }>
      plain('plain', ({ a }) => a)
    })
    assert.match(run.errors.swap?.[0] ?? '', /cycle: b <- a <- b\.$/)
    assert.match(run.errors.plain?.[0] ?? '', /cycle: c <- a <- c\.$/)
  })

  test("a fixture that returns no promise fails with Vitest's TypeError; a throw after use fails the test", async () => {
    const run = await runScript((api) => {
      const sync = fixtureTest(api).extend<{ v: number }>({
        v: (({ task: _task }: { task: unknown }, use: Use<number>) => {
          void use(1)
        }) as never,
      })
      sync('sync', ({ v }) => v)
      const late = fixtureTest(api).extend<{ v: number }>({
        v: (({ task: _task }: { task: unknown }, use: Use<number>) => {
          void use(1)
          throw new Error('late')
        }) as never,
      })
      late('late', ({ v }) => v)
    })
    assert.equal(run.states.sync, 'fail')
    assert.match(
      run.errors.sync?.[0] ?? '',
      /Cannot read properties of undefined \(reading 'then'\)/,
    )
    assert.equal(run.states.late, 'fail')
    assert.equal(run.errors.late?.[0], 'late')
  })

  test('an injected value of null keeps the default; options are own keys only', async () => {
    class Options {
      get scope(): string {
        return 'file'
      }
    }
    const instance = new Options()
    const seen: unknown[] = []
    await runScript(
      (api) => {
        const it = fixtureTest(api).extend<{ given: string; pair: unknown[] }>({
          given: ['default', { injected: true }],
          pair: [1, instance] as never,
        })
        it('t', ({ given, pair }) => {
          seen.push(given, pair)
        })
      },
      {},
      { injectValue: () => null },
    )
    assert.equal(seen[0], 'default')
    assert.deepEqual(seen[1], [1, instance], 'an instance with a prototype scope getter is a value')
  })

  test('a fixture slower than the test timeout: the body is never called late, its cleanup runs', async () => {
    const clock = FakeTimers.createClock(0)
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const trace: string[] = []
    const running = runScript(
      (api) => {
        const it = fixtureTest(api).extend<{ slow: string }>({
          slow: async ({ task: _task }: { task: unknown }, use: Use<string>) => {
            started.resolve()
            await gate.promise
            await use('v')
            trace.push('cleanup')
          },
        })
        it('t', ({ slow }) => trace.push(`body ${slow}`))
      },
      { timeouts: { test: 100 } },
      clockOptions(clock),
    )
    await started.promise
    await clock.tickAsync(100)
    const run = await running
    assert.equal(run.states.t, 'fail')
    gate.resolve()
    await settle()
    assert.deepEqual(trace, ['cleanup'])
  })
})

describe('definitions.plainSuiteHook', () => {
  test('pass-suite (neutral): a plain beforeAll that destructures gets the suite, in a file with no fixtures', async () => {
    const names: string[] = []
    const run = await runScript((api) => {
      api.describe('block', () => {
        api.beforeAll((({ name }: { name: string }) => {
          names.push(name)
        }) as never)
        api.test('t', () => undefined)
      })
    })
    assert.deepEqual(names, ['block'])
    assert.equal(run.states['block > t'], 'pass')
  })
})
