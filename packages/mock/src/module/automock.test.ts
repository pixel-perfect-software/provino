import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ModulePolicy } from '@provino/types'
import { neutral } from '../internal/test-support.ts'
import { createMockFn, isMockFunction } from '../mock-fn.ts'
import { createMockRegistry } from '../registry.ts'
import { type AutomockMode, automock } from './automock.ts'

// biome-ignore lint/suspicious/noExplicitAny: the mocked output is probed through chains of unknown members
type Bag = Record<string, any>

function run(
  value: unknown,
  shape: ModulePolicy['automockShape'],
  mode: AutomockMode = 'automock',
): Bag {
  const registry = createMockRegistry()
  return automock(value, shape, mode, (options) => createMockFn(neutral, registry, options)) as Bag
}

const mocked = (value: unknown): boolean => isMockFunction(neutral, value)

for (const shape of ['metadata', 'deep'] as const) {
  describe(`automock, ${shape} shape`, () => {
    test('functions become mocks that return undefined, and keep their name', () => {
      const out = run(
        {
          add: function add(a: number, b: number) {
            return a + b
          },
        },
        shape,
      )
      assert.ok(mocked(out.add))
      assert.equal(out.add(1, 2), undefined)
      assert.equal(out.add.name, 'add')
      assert.deepEqual(out.add.mock.calls, [[1, 2]])
    })

    test("a class's constructor body never runs, and its methods are mocks", () => {
      let ran = false
      class Thing {
        constructor() {
          ran = true
        }
        greet(): string {
          return 'hi'
        }
        static make(): Thing {
          return new Thing()
        }
      }
      const out = run({ Thing }, shape)
      const instance = new out.Thing()
      assert.equal(ran, false)
      assert.ok(mocked(out.Thing))
      assert.ok(mocked(instance.greet))
      assert.equal(instance.greet(), undefined)
      assert.ok(mocked(out.Thing.make), 'statics are mocked')
    })

    test("an instance gets its own method mocks when the policy's `new` is an apply (jest-mock)", () => {
      class Thing {
        greet(): string {
          return 'hi'
        }
      }
      const applying = { ...neutral, newCall: 'apply' } as const
      const registry = createMockRegistry()
      const out = automock({ Thing }, shape, 'automock', (options) =>
        createMockFn(applying, registry, options),
      ) as Bag
      const instance = new out.Thing()
      assert.ok(Object.hasOwn(instance, 'greet'), 'an own method, not the prototype one')
      assert.notEqual(instance.greet, out.Thing.prototype.greet)
    })

    test("each instance's method records into the prototype's mock too", () => {
      class Thing {
        greet(_who: string): string {
          return 'hi'
        }
      }
      const out = run({ Thing }, shape)
      const a = new out.Thing()
      const b = new out.Thing()
      assert.notEqual(a.greet, b.greet, 'one mock per instance')
      a.greet('x')
      b.greet('y')
      assert.deepEqual(a.greet.mock.calls, [['x']])
      assert.deepEqual(out.Thing.prototype.greet.mock.calls, [['x'], ['y']])
      assert.ok(out.Thing.prototype.constructor === out.Thing)
    })

    test('nested objects are mocked and getters read undefined', () => {
      const source = {
        nested: { deep: { fn: () => 1 } },
        get value() {
          return 5
        },
      }
      const out = run(source, shape)
      assert.ok(mocked(out.nested.deep.fn))
      assert.equal(out.value, undefined)
      assert.notEqual(out.nested, source.nested)
    })

    test('arrays become [], and Maps, primitives and null are kept', () => {
      const map = new Map([[1, 2]])
      const out = run(
        { list: [1, 2], map, n: 3, s: 's', yes: true, nothing: null, undef: undefined },
        shape,
      )
      assert.deepEqual(out.list, [])
      assert.equal(out.map, map)
      assert.equal(out.n, 3)
      assert.equal(out.s, 's')
      assert.equal(out.yes, true)
      assert.equal(out.nothing, null)
      assert.equal('undef' in out, true)
    })

    test('a cycle terminates and points at the mock', () => {
      const a: Bag = { name: 'a', fn: () => 1 }
      a.self = a
      a.child = { parent: a }
      const out = run(a, shape)
      assert.equal(out.self, out)
      assert.equal(out.child.parent, out)
      assert.ok(mocked(out.fn))
    })

    test('a function module is a callable mock with mocked statics', () => {
      const fn = Object.assign(() => 1, { helper: () => 2 })
      const out = run(fn, shape) as unknown as Bag & (() => unknown)
      assert.ok(mocked(out))
      assert.equal(out(), undefined)
      assert.ok(mocked(out.helper))
    })

    test('autospy calls through', () => {
      class Counter {
        n = 0
        inc(): number {
          return ++this.n
        }
      }
      const out = run({ double: (x: number) => x * 2, label: 'l' }, shape, 'autospy')
      assert.equal(out.double(2), 4)
      assert.deepEqual(out.double.mock.calls, [[2]])
      assert.equal(out.label, 'l')
      const spied = run({ Counter }, shape, 'autospy')
      const counter = new spied.Counter()
      assert.equal(counter.inc(), 1)
      assert.equal(counter.n, 1, 'the real constructor ran')
    })
  })
}

describe('automock, metadata shape only', () => {
  test('Date and BigInt exports are dropped, a RegExp is emptied, a Promise is dropped', () => {
    const out = run(
      { when: new Date(0), big: 10n, pattern: /abc/gi, later: Promise.resolve(1), keep: 1 },
      'metadata',
    )
    assert.equal('when' in out, false)
    assert.equal('big' in out, false)
    assert.equal('later' in out, false)
    assert.ok(out.pattern instanceof RegExp)
    assert.equal(out.pattern.source, '(?:)')
    assert.equal(out.keep, 1)
  })

  test('an ES module namespace gets __esModule, which does not enumerate', async () => {
    const namespace = await import('node:path')
    const out = run(namespace, 'metadata')
    assert.equal(out.__esModule, true)
    assert.equal(Object.keys(out).includes('__esModule'), false)
    assert.ok(mocked(out.join))
  })

  test('a getter is absent (not a slot), except on an object marked __esModule', () => {
    const plain = run(
      {
        get x() {
          return 1
        },
      },
      'metadata',
    )
    assert.equal('x' in plain, false)
    const esm = run(
      Object.defineProperty(
        {
          get x() {
            return 1
          },
        },
        '__esModule',
        { value: true },
      ),
      'metadata',
    )
    assert.equal(esm.x, 1, 'the getter is read, and the value mocked as a constant')
  })

  test('a root with no metadata throws', () => {
    assert.throws(() => run(new Date(0), 'metadata'), { code: 'automock-no-metadata' })
  })

  test('names are made safe as jest-mock does', () => {
    const out = run(
      {
        a: Object.defineProperty(() => 1, 'name', { value: 'class' }),
        b: Object.defineProperty(() => 1, 'name', { value: 'a-b c' }),
        c: Object.defineProperty(() => 1, 'name', { value: '9x' }),
        d: Object.defineProperty(() => 1, 'name', { value: 'bound go' }),
        e: Object.defineProperty(() => 1, 'name', { value: 'mockConstructor' }),
      },
      'metadata',
    )
    assert.equal(out.a.name, '$class')
    assert.equal(out.b.name, 'a$b$c')
    assert.equal(out.c.name, '$9x')
    assert.equal(out.d.name, 'bound go')
    const plain = createMockFn(neutral, createMockRegistry())
    assert.equal(out.e.name, plain.name, 'mockConstructor leaves the mock its default name')
  })
})

describe('automock, deep shape only', () => {
  test('Dates and RegExps are kept; the root is a plain object, not a namespace', () => {
    const when = new Date(0)
    const out = run({ when, pattern: /x/ }, 'deep')
    assert.equal(out.when, when)
    assert.equal(out.pattern.source, 'x')
    assert.equal(Object.getPrototypeOf(out), Object.prototype)
  })

  test('a getter is an accessor that returns undefined, and a setter stays settable', () => {
    const out = run(
      {
        get value() {
          return 1
        },
        set value(_v: number) {},
      },
      'deep',
    )
    const descriptor = Object.getOwnPropertyDescriptor(out, 'value')
    assert.equal(typeof descriptor?.get, 'function')
    assert.equal(typeof descriptor?.set, 'function')
    assert.equal(out.value, undefined)
  })

  test('autospy keeps real getters and mutates nothing it cannot call through', () => {
    const source = {
      get live() {
        return 7
      },
      fn: () => 'real',
    }
    const out = run(source, 'deep', 'autospy')
    assert.equal(out.live, 7)
    assert.equal(out.fn(), 'real')
    assert.ok(mocked(out.fn))
  })

  test('symbol keys are mocked too', () => {
    const key = Symbol('k')
    const out = run({ [key]: () => 1 }, 'deep')
    assert.ok(mocked(out[key as unknown as string]))
  })
})
