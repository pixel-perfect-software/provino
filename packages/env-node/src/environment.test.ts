// T8.2, node part: after `teardown`, the global's property names and every original descriptor
// equal what `setup` saw. These tests change the real `globalThis` (a builtin is overwritten, one
// is deleted), so each runs synchronously and inside `guarded`, which puts back the keys the test
// touched from descriptors it saved itself, whether or not `teardown` worked.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import type { EnvironmentInstance, EnvironmentSetupContext } from '@provino/types'
import { nodeEnvironment } from './index.ts'

type Key = string | symbol
type Properties = ReadonlyMap<Key, PropertyDescriptor>

const context: EnvironmentSetupContext<Record<string, never>> = {
  options: {},
  realm: 'worker',
  scope: 'file',
  testPath: '/a.test.ts',
  pragmas: {},
  console,
  signal: new AbortController().signal,
}

/** Every own property of the global, read key by key (the way `setup` reads them). */
function properties(): Properties {
  const all = new Map<Key, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key)
    if (descriptor !== undefined) all.set(key, descriptor)
  }
  return all
}

// The first read of a descriptor loads Node's lazy globals (undici's two non-configurable
// symbols among them). Do it once up front, so no test sees them appear.
properties()

/** Runs `body`, then puts `keys` back as they were when it started, `teardown` or not. */
function guarded(keys: readonly Key[], body: () => void): void {
  const saved = keys.map((key) => [key, Reflect.getOwnPropertyDescriptor(globalThis, key)] as const)
  try {
    body()
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Reflect.defineProperty(globalThis, key, descriptor)
    }
  }
}

/**
 * `guarded`, and afterwards the keys are assigned their old values back through the global. For the
 * accessors whose value lives in a closure (`process`, `Buffer`, `performance`): putting a
 * descriptor back does not undo an assignment, so a teardown that fails to would leave the test
 * process with a fake `process`. The values are read before `body` runs.
 */
function guardedValues(keys: readonly Key[], body: () => void): void {
  const values = keys.map((key) => [key, Reflect.get(globalThis, key)] as const)
  try {
    guarded(keys, body)
  } finally {
    for (const [key, value] of values) Reflect.set(globalThis, key, value)
  }
}

/**
 * Defines a get/set accessor on the global whose value lives in a closure, the way Node's
 * `process` does, and counts how often each side is called. Call it inside `guarded([name], …)`.
 */
function closureAccessor(name: string): {
  readonly state: { value: string; reads: number; writes: number }
  readonly descriptor: PropertyDescriptor
} {
  const state = { value: 'original', reads: 0, writes: 0 }
  const descriptor: PropertyDescriptor = {
    get(): string {
      state.reads++
      return state.value
    },
    set(value: string): void {
      state.writes++
      state.value = value
    },
    enumerable: false,
    configurable: true,
  }
  Object.defineProperty(globalThis, name, descriptor)
  return { state, descriptor }
}

function setUp(): EnvironmentInstance {
  const instance = nodeEnvironment.setup(context, undefined)
  assert.ok(!(instance instanceof Promise), 'the node environment sets up synchronously')
  return instance
}

function tearDown(instance: EnvironmentInstance): void {
  assert.equal(instance.teardown(), undefined, 'the node environment tears down synchronously')
}

/** The keys of `list` that are not in `omit`, in order. */
function without(list: readonly Key[], omit: readonly Key[]): Key[] {
  return list.filter((key) => !omit.includes(key))
}

/**
 * Sets up the environment, runs `change`, tears down, and checks the global: the same property
 * names, and each key's descriptor deep-equal to the one `setup` saw. The checks, and `verify`,
 * run before `guarded` puts anything back on its own, so a restore that did nothing fails them.
 * Returns the key order before and after. `touched` lists every key `change` may add, change or
 * delete.
 */
function roundTrip(
  touched: readonly Key[],
  change: () => void,
  verify: () => void = () => {},
): { readonly before: readonly Key[]; readonly after: readonly Key[] } {
  const before = properties()
  const orderBefore = Reflect.ownKeys(globalThis)
  let orderAfter: readonly Key[] = []
  guarded(touched, () => {
    const instance = setUp()
    assert.equal(instance.global, globalThis)
    change()
    tearDown(instance)
    const after = properties()
    assert.deepEqual(new Set(after.keys()), new Set(before.keys()), 'the same property names')
    for (const [key, descriptor] of before) {
      assert.deepStrictEqual(after.get(key), descriptor, `descriptor of ${String(key)}`)
    }
    verify()
    orderAfter = Reflect.ownKeys(globalThis)
  })
  return { before: orderBefore, after: orderAfter }
}

test('the environment is the node one, in the worker realm only', () => {
  assert.equal(nodeEnvironment.name, 'node')
  assert.deepEqual(nodeEnvironment.realms, ['worker'])
  assert.equal(nodeEnvironment.prepare, undefined)
})

test('a new string key and a new symbol key are removed', () => {
  const symbol = Symbol('leaked')
  const { before, after } = roundTrip(
    ['leakedByTest', symbol],
    () => {
      Reflect.set(globalThis, 'leakedByTest', 1)
      Reflect.set(globalThis, symbol, 2)
    },
    () => {
      assert.equal('leakedByTest' in globalThis, false)
      assert.equal(symbol in globalThis, false)
    },
  )
  assert.deepEqual(after, before, 'nothing was deleted, so the order is unchanged too')
})

test('an overwritten builtin is put back, the same function', () => {
  const original = globalThis.setTimeout
  const { before, after } = roundTrip(
    ['setTimeout'],
    () => {
      Reflect.set(globalThis, 'setTimeout', () => 'fake')
    },
    () => assert.equal(globalThis.setTimeout, original),
  )
  assert.deepEqual(after, before, 'redefining a key in place does not move it')
})

test('a deleted builtin comes back', () => {
  const original = globalThis.URL
  const { before, after } = roundTrip(
    ['URL'],
    () => {
      assert.ok(Reflect.deleteProperty(globalThis, 'URL'))
      assert.equal('URL' in globalThis, false)
    },
    () => assert.equal(globalThis.URL, original),
  )
  // The limit: a deleted key is re-added after every key that was never deleted, so `URL` is now
  // the last string key. The order of every key that was never deleted is what it was.
  assert.deepEqual(without(after, ['URL']), without(before, ['URL']))
  assert.equal(after.filter((key) => typeof key === 'string').at(-1), 'URL')
})

test('a getter defined over a value is replaced by the value', () => {
  const original = Reflect.getOwnPropertyDescriptor(globalThis, 'parseFloat')
  assert.ok(original && 'value' in original)
  const { before, after } = roundTrip(
    ['parseFloat'],
    () => {
      Object.defineProperty(globalThis, 'parseFloat', {
        get: () => 'getter',
        configurable: true,
        enumerable: false,
      })
    },
    () =>
      assert.deepStrictEqual(Reflect.getOwnPropertyDescriptor(globalThis, 'parseFloat'), original),
  )
  assert.deepEqual(after, before)
})

test('a value defined over a getter is replaced by the getter', () => {
  const original = Reflect.getOwnPropertyDescriptor(globalThis, 'process')
  assert.ok(original?.get, 'process is an accessor on the global')
  const { before, after } = roundTrip(
    ['process'],
    () => {
      Object.defineProperty(globalThis, 'process', { value: 'not a process', configurable: true })
    },
    () => assert.deepStrictEqual(Reflect.getOwnPropertyDescriptor(globalThis, 'process'), original),
  )
  assert.deepEqual(after, before)
})

test('a plain assignment over process, Buffer and performance is undone', () => {
  // Node defines these as get/set accessors whose value lives in a closure: assigning changes the
  // closure and leaves the descriptor identical, so comparing descriptors alone never notices.
  const names = ['process', 'Buffer', 'performance']
  const originals = names.map((name) => Reflect.get(globalThis, name))
  for (const name of names) {
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, name)
    assert.ok(descriptor?.get && descriptor.set, `${name} is a get/set accessor on the global`)
  }
  guardedValues(names, () => {
    const { before, after } = roundTrip(
      names,
      () => {
        Reflect.set(globalThis, 'process', { env: { FAKE: '1' } })
        Reflect.set(globalThis, 'Buffer', class Fake {})
        Reflect.set(globalThis, 'performance', { now: () => 42 })
      },
      () => {
        names.forEach((name, index) => {
          assert.equal(Reflect.get(globalThis, name), originals[index], `${name} is back`)
        })
      },
    )
    assert.deepEqual(after, before)
  })
})

test('the setter wrapper is gone after teardown: the descriptors are the originals', () => {
  const accessors = [...properties()].filter(([, descriptor]) => descriptor.get !== undefined)
  const settable = accessors.filter(([, descriptor]) => descriptor.set !== undefined)
  const getterOnly = accessors.filter(([, descriptor]) => descriptor.set === undefined)
  const names = ['process', 'Buffer', 'performance']
  assert.deepEqual(
    names.filter((name) => !settable.some(([key]) => key === name)),
    [],
    'the three are settable accessors on this Node',
  )
  guardedValues(names, () => {
    const instance = setUp()
    // Only the setter is wrapped, and only on the accessors that have both sides.
    for (const [key, original] of settable.filter(([key]) => names.includes(key as string))) {
      const wrapped = Reflect.getOwnPropertyDescriptor(globalThis, key)
      assert.equal(wrapped?.get, original.get, `${String(key)} keeps its getter`)
      assert.equal(wrapped?.enumerable, original.enumerable)
      assert.equal(wrapped?.configurable, original.configurable)
    }
    for (const [key, original] of getterOnly) {
      assert.deepStrictEqual(Reflect.getOwnPropertyDescriptor(globalThis, key), original)
    }
    for (const name of names) Reflect.set(globalThis, name, Reflect.get(globalThis, name))
    tearDown(instance)
    for (const [key, original] of accessors) {
      const restored = Reflect.getOwnPropertyDescriptor(globalThis, key)
      assert.equal(restored?.get, original.get, `${String(key)} getter`)
      assert.equal(restored?.set, original.set, `${String(key)} setter`)
      assert.deepStrictEqual(restored, original)
    }
  })
})

test('a setup and teardown with nothing in between change nothing and read no getter', () => {
  const name = '__provinoClosureAccessor'
  guarded([name], () => {
    const { state, descriptor } = closureAccessor(name)
    const { before, after } = roundTrip([name], () => {})
    assert.deepEqual(after, before)
    assert.deepStrictEqual(Reflect.getOwnPropertyDescriptor(globalThis, name), descriptor)
    assert.deepEqual(state, { value: 'original', reads: 0, writes: 0 })
  })
})

test('an assignment to a closure-backed accessor is undone, and the getter is read once', () => {
  const name = '__provinoClosureAccessor'
  guarded([name], () => {
    const { state, descriptor } = closureAccessor(name)
    roundTrip(
      [name],
      () => {
        Reflect.set(globalThis, name, 'first')
        Reflect.set(globalThis, name, 'second')
        assert.equal(Reflect.get(globalThis, name), 'second', 'the test sees its own value')
      },
      () => {
        assert.deepStrictEqual(Reflect.getOwnPropertyDescriptor(globalThis, name), descriptor)
        assert.equal(Reflect.get(globalThis, name), 'original')
      },
    )
    // One read for the first assignment, one by the test, one by the check above.
    assert.deepEqual(state, { value: 'original', reads: 3, writes: 3 })
  })
})

for (const [change, how] of [
  [(name: string) => Object.defineProperty(globalThis, name, { value: 'x' }), 'redefined'],
  [(name: string) => Reflect.deleteProperty(globalThis, name), 'deleted'],
] as const) {
  test(`an assignment is undone even when the key was ${how} afterwards`, () => {
    const name = '__provinoClosureAccessor'
    guarded([name], () => {
      const { state, descriptor } = closureAccessor(name)
      roundTrip(
        [name],
        () => {
          Reflect.set(globalThis, name, 'assigned')
          change(name)
        },
        () =>
          assert.deepStrictEqual(Reflect.getOwnPropertyDescriptor(globalThis, name), descriptor),
      )
      assert.equal(state.value, 'original')
    })
  })
}

test('a changed enumerable flag is put back, both ways', () => {
  // `Array` is not enumerable on the global and `setTimeout` is.
  const flags = (): readonly (boolean | undefined)[] =>
    ['Array', 'setTimeout'].map(
      (key) => Reflect.getOwnPropertyDescriptor(globalThis, key)?.enumerable,
    )
  assert.deepEqual(flags(), [false, true])
  roundTrip(
    ['Array', 'setTimeout'],
    () => {
      Object.defineProperty(globalThis, 'Array', { enumerable: true })
      Object.defineProperty(globalThis, 'setTimeout', { enumerable: false })
      assert.deepEqual(flags(), [true, false])
    },
    () => assert.deepEqual(flags(), [false, true]),
  )
})

test('a changed writable flag is put back', () => {
  // Not `configurable: false`: that cannot be undone on the real global, by the test's safety net
  // either. The unrestorable cases are in restore.test.ts, on plain objects.
  roundTrip(
    ['parseInt'],
    () => {
      Object.defineProperty(globalThis, 'parseInt', { writable: false })
    },
    () => {
      const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, 'parseInt')
      assert.equal(descriptor?.writable, true)
      assert.equal(descriptor?.configurable, true)
    },
  )
})

test('a lazy global that replaces itself with a value on first access gets its getter back', () => {
  // The shape of Node's `defineLazyProperties`: an accessor that, on first read, redefines itself
  // as a writable value property. Defined before `setup`, so it is part of what `setup` saw.
  const name = '__provinoLazyGlobal'
  guarded([name], () => {
    const lazy = {
      get(): string {
        Object.defineProperty(globalThis, name, {
          value: 'loaded',
          writable: true,
          enumerable: false,
          configurable: true,
        })
        return 'loaded'
      },
      set(value: unknown): void {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
      },
      enumerable: false,
      configurable: true,
    }
    Object.defineProperty(globalThis, name, lazy)
    const instance = setUp()
    assert.equal(Reflect.get(globalThis, name), 'loaded')
    assert.equal(
      Reflect.getOwnPropertyDescriptor(globalThis, name)?.get,
      undefined,
      'it replaced itself',
    )
    tearDown(instance)
    const restored = Reflect.getOwnPropertyDescriptor(globalThis, name)
    assert.equal(restored?.get, lazy.get)
    assert.equal(restored?.set, lazy.set)
    assert.equal(restored?.value, undefined)
  })
})

test('every accessor global and every Node lazy global can be read, and is still restored', () => {
  // On Node 22 `BroadcastChannel` and `CompressionStream` are getters that replace themselves on
  // first access; on 24 they are V8 lazy data properties and `process`, `Buffer`, `performance`,
  // `crypto` and `navigator` are the accessors. Reading all of them covers whichever form this
  // Node uses.
  const names = ['BroadcastChannel', 'CompressionStream', 'DecompressionStream', 'WebSocket']
  const accessors = [...properties()]
    .filter(([, descriptor]) => descriptor.get !== undefined)
    .map(([key]) => key)
  assert.ok(accessors.length > 0, 'this Node defines accessor globals')
  const touched = [...new Set<Key>([...names, ...accessors])]
  const { before, after } = roundTrip(touched, () => {
    for (const key of touched) Reflect.get(globalThis, key)
  })
  assert.deepEqual(after, before)
})

test('all the changes at once come back together', () => {
  const symbol = Symbol('leaked')
  const touched = ['leakedByTest', symbol, 'setTimeout', 'URL', 'parseFloat', 'Array']
  const original = { setTimeout: globalThis.setTimeout, URL: globalThis.URL }
  const { before, after } = roundTrip(
    touched,
    () => {
      Reflect.set(globalThis, 'leakedByTest', 1)
      Reflect.set(globalThis, symbol, 2)
      Reflect.set(globalThis, 'setTimeout', () => 'fake')
      Reflect.deleteProperty(globalThis, 'URL')
      Object.defineProperty(globalThis, 'parseFloat', { get: () => 'getter', configurable: true })
      Object.defineProperty(globalThis, 'Array', { enumerable: true })
    },
    () => {
      assert.equal(globalThis.setTimeout, original.setTimeout)
      assert.equal(globalThis.URL, original.URL)
    },
  )
  assert.deepEqual(without(after, ['URL']), without(before, ['URL']))
})

test('setup and teardown can repeat on one global, and teardown twice is harmless', () => {
  const { before, after } = roundTrip(['leakedByTest'], () => {
    Reflect.set(globalThis, 'leakedByTest', 1)
  })
  assert.deepEqual(after, before)
  guarded(['leakedByTest'], () => {
    const instance = setUp()
    Reflect.set(globalThis, 'leakedByTest', 2)
    tearDown(instance)
    tearDown(instance)
    assert.equal('leakedByTest' in globalThis, false)
  })
})

test('a file-scoped environment does not see the previous file leave anything behind', () => {
  // Two files in a row on one worker: the second one's `setup` sees the first one's restored
  // global, so what the first added is not in the second's baseline.
  guarded(['firstFilesGlobal'], () => {
    const first = setUp()
    Reflect.set(globalThis, 'firstFilesGlobal', true)
    tearDown(first)
    const second = setUp()
    assert.equal('firstFilesGlobal' in globalThis, false)
    tearDown(second)
  })
})

test('the context realm is refused with a coded error', () => {
  assert.throws(
    () => nodeEnvironment.setup({ ...context, realm: 'context' }, undefined),
    (error) =>
      error instanceof Error && 'code' in error && error.code === 'ENV_NODE_REALM_UNSUPPORTED',
  )
})

test('D22: a global a test cannot remove is reported, not thrown, and everything else is restored', () => {
  // A non-configurable global can never be removed from a process, so this runs in a child. The
  // second `setup` is the next file in the same worker: it sees the stuck key as part of its
  // baseline, so it reports nothing.
  const script = `
    const { nodeEnvironment } = await import(process.argv[1])
    const context = {
      options: {}, realm: 'worker', scope: 'file', testPath: '/a.test.ts', pragmas: {},
      console, signal: new AbortController().signal,
    }
    const first = nodeEnvironment.setup(context, undefined)
    Object.defineProperty(globalThis, '__provinoStuck', { value: 1, configurable: false })
    Object.defineProperty(globalThis, Symbol('stuckSymbol'), { value: 1, configurable: false })
    globalThis.addedByTest = 1
    let report, error
    try { report = first.teardown() } catch (thrown) { error = String(thrown) }
    const second = nodeEnvironment.setup(context, undefined)
    const again = second.teardown()
    console.log(JSON.stringify({
      report, error, addedGone: !('addedByTest' in globalThis), again: again === undefined,
    }))
  `
  const output = execFileSync(
    process.execPath,
    [
      '--conditions=provino-source',
      '--input-type=module',
      '-e',
      script,
      new URL('./index.ts', import.meta.url).href,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  assert.deepEqual(JSON.parse(output), {
    report: { leakedGlobals: ['__provinoStuck', 'Symbol(stuckSymbol)'] },
    addedGone: true,
    again: true,
  })
})
