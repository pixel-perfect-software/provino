import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { GlobalReadWatch } from '@provino/types'
import {
  adoptingGlobals,
  perFileKeys,
  readGlobalBaseline,
  watchPerFileGlobals,
} from './external-probe.ts'

/** A stand-in global: what the worker boots with, then what a file's setup adds and changes. */
function fileGlobal(): {
  global: Record<string, unknown>
  baseline: ReturnType<typeof readGlobalBaseline>
} {
  const global: Record<string, unknown> = { setTimeout: () => 0, Event: class {}, process: {} }
  const baseline = readGlobalBaseline(global)
  const window = { document: { body: {} } }
  Object.assign(global, { expect: {}, afterEach: () => {} })
  // The environment's populated keys are accessors over the window, as `populateGlobal` makes them.
  Object.defineProperty(global, 'document', {
    configurable: true,
    enumerable: true,
    get: () => window.document,
    set: (value: { body: object }) => {
      window.document = value
    },
  })
  Object.defineProperty(global, 'Event', { configurable: true, enumerable: true, value: class {} })
  // A per-file `process` copy is never watched.
  global.process = {}
  return { global, baseline }
}

/**
 * Wraps the setter of every configurable get/set accessor of `target` and keeps its getter, as
 * `@provino/env-shared`'s `snapshotProperties` does for a file (the orchestrator may not import
 * it). Returns the call that puts the originals back.
 */
function wrapSettersAsSnapshotDoes(target: object): () => void {
  const originals: [string, PropertyDescriptor][] = []
  for (const key of Object.getOwnPropertyNames(target)) {
    const original = Object.getOwnPropertyDescriptor(target, key)
    if (original?.get === undefined || original.set === undefined) continue
    if (original.configurable !== true) continue
    const set = original.set
    Object.defineProperty(target, key, {
      ...original,
      set(this: unknown, value: unknown) {
        Reflect.apply(set, this, [value])
      },
    })
    originals.push([key, original])
  }
  return () => {
    for (const [key, original] of originals) Object.defineProperty(target, key, original)
  }
}

describe('the external probe (D127, P42)', () => {
  it('watches what the file installed or changed, never what the worker booted with or process', () => {
    const { global, baseline } = fileGlobal()
    assert.deepEqual(
      perFileKeys(global, baseline)
        .map(([key]) => key)
        .toSorted(),
      ['Event', 'afterEach', 'document', 'expect'],
    )
  })

  it('reports a read of a per-file global, and puts every descriptor back', () => {
    const { global, baseline } = fileGlobal()
    const before = Object.getOwnPropertyDescriptors(global)
    const end = watchPerFileGlobals(global, baseline)
    assert.equal(typeof global.expect, 'object', 'the read sees the real value')
    assert.equal(end(), true)
    assert.deepEqual(Object.getOwnPropertyDescriptors(global), before, 'no getter is left behind')
  })

  it('says nothing was read when the load touched only the worker’s own globals', () => {
    const { global, baseline } = fileGlobal()
    const end = watchPerFileGlobals(global, baseline)
    void global.setTimeout
    void global.process
    assert.equal(end(), false)
  })

  it('forwards an accessor’s reads and writes, and keeps a data key a load assigned', () => {
    const { global, baseline } = fileGlobal()
    const end = watchPerFileGlobals(global, baseline)
    const replaced = { body: { replaced: true } }
    global.document = replaced
    global.expect = 'assigned'
    assert.equal(global.document, replaced)
    assert.equal(end(), true)
    assert.equal(global.document, replaced, 'the setter reached the window')
    assert.equal(Object.getOwnPropertyDescriptor(global, 'expect')?.value, 'assigned')
  })

  it('leaves a key the load redefined itself as the load left it', () => {
    const { global, baseline } = fileGlobal()
    const end = watchPerFileGlobals(global, baseline)
    Object.defineProperty(global, 'afterEach', { configurable: true, value: 'mine' })
    end()
    assert.equal(global.afterEach, 'mine')
  })

  it('gives a read-only key a getter only, so a strict write throws, and puts it back exactly', () => {
    const { global, baseline } = fileGlobal()
    Object.defineProperty(global, 'frozen', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: 1,
    })
    const before = Object.getOwnPropertyDescriptor(global, 'frozen')
    const end = watchPerFileGlobals(global, baseline)
    assert.equal(Object.getOwnPropertyDescriptor(global, 'frozen')?.set, undefined)
    // A module is strict code.
    assert.throws(() => {
      global.frozen = 2
    }, TypeError)
    assert.equal(global.frozen, 1)
    assert.equal(end(), true)
    assert.deepEqual(Object.getOwnPropertyDescriptor(global, 'frozen'), before)
  })

  it('gives a getter-only accessor no setter while it watches', () => {
    const { global, baseline } = fileGlobal()
    const get = (): number => 7
    Object.defineProperty(global, 'readonlyGetter', { configurable: true, get })
    const end = watchPerFileGlobals(global, baseline)
    assert.equal(Object.getOwnPropertyDescriptor(global, 'readonlyGetter')?.set, undefined)
    end()
    assert.equal(Object.getOwnPropertyDescriptor(global, 'readonlyGetter')?.get, get)
  })

  it('leaves a non-configurable per-file key as it was: it can’t be watched', () => {
    const { global, baseline } = fileGlobal()
    Object.defineProperty(global, 'pinned', { configurable: false, writable: true, value: 'x' })
    const before = Object.getOwnPropertyDescriptor(global, 'pinned')
    assert.ok(!perFileKeys(global, baseline).some(([key]) => key === 'pinned'))
    const end = watchPerFileGlobals(global, baseline)
    assert.deepEqual(Object.getOwnPropertyDescriptor(global, 'pinned'), before)
    void global.pinned
    assert.equal(end(), false, 'a read of it goes unnoticed')
    assert.deepEqual(Object.getOwnPropertyDescriptor(global, 'pinned'), before)
  })

  it('hears the keys the environment covers through it, and redefines none of them', () => {
    const { global, baseline } = fileGlobal()
    const documentGet = Object.getOwnPropertyDescriptor(global, 'document')?.get
    let listener: (() => void) | null = null
    const covered: GlobalReadWatch = {
      covers: (key, descriptor) => key === 'document' && descriptor.get === documentGet,
      watch(onRead) {
        listener = onRead
        return () => {
          listener = null
        }
      },
    }
    const end = watchPerFileGlobals(global, baseline, covered)
    assert.equal(
      Object.getOwnPropertyDescriptor(global, 'document')?.get,
      documentGet,
      'not redefined',
    )
    assert.notEqual(listener, null)
    ;(listener as unknown as () => void)()
    assert.equal(end(), true, 'the environment’s accessor reported the read')
    assert.equal(listener, null, 'the listener is gone once the window closes')
  })

  it('does not watch an accessor whose setter alone was wrapped (the environment’s per-file snapshot)', () => {
    // `@provino/env-shared`'s `snapshotProperties` wraps the setter of every configurable get/set
    // accessor (`Buffer`, `performance`, Node 26's `localStorage`) and keeps its getter.
    const global: Record<string, unknown> = {}
    const store = { value: 1 }
    Object.defineProperty(global, 'performance', {
      configurable: true,
      enumerable: true,
      get: () => store.value,
      set: (next: number) => {
        store.value = next
      },
    })
    const baseline = readGlobalBaseline(global)
    wrapSettersAsSnapshotDoes(global)
    assert.deepEqual(perFileKeys(global, baseline), [])
    const end = watchPerFileGlobals(global, baseline)
    void global.performance
    assert.equal(end(), false, 'a package that reads `performance` at load is not learned')
  })

  it('on the real global, a per-file snapshot alone leaves no key to watch', () => {
    const baseline = readGlobalBaseline(globalThis)
    const restore = wrapSettersAsSnapshotDoes(globalThis)
    try {
      assert.deepEqual(
        perFileKeys(globalThis, baseline).map(([key]) => key),
        [],
      )
      const end = watchPerFileGlobals(globalThis, baseline)
      void typeof performance
      void typeof Buffer
      assert.equal(end(), false)
    } finally {
      restore()
    }
  })

  it('still watches an accessor whose getter the file replaced', () => {
    const global: Record<string, unknown> = {}
    Object.defineProperty(global, 'performance', {
      configurable: true,
      get: () => 1,
      set: () => {},
    })
    const baseline = readGlobalBaseline(global)
    Object.defineProperty(global, 'performance', {
      configurable: true,
      get: () => 2,
      set: () => {},
    })
    assert.deepEqual(
      perFileKeys(global, baseline).map(([key]) => key),
      ['performance'],
    )
  })

  it('still watches a covered key the file redefined since', () => {
    const { global, baseline } = fileGlobal()
    const covered: GlobalReadWatch = { covers: () => false, watch: () => () => {} }
    const end = watchPerFileGlobals(global, baseline, covered)
    void global.document
    assert.equal(end(), true)
  })
})

describe('the external probe’s writes (B23f, reevaluatePatchingExternals)', () => {
  const BOTH = { reads: true, writes: true } as const
  const WRITES = { reads: false, writes: true } as const

  it('counts a key the load added, which the reads alone never see', () => {
    const { global, baseline } = fileGlobal()
    const reads = watchPerFileGlobals(global, baseline)
    global.__addedByLoad = {}
    assert.equal(reads(), false, 'no per-file key was read')
    delete global.__addedByLoad
    const end = watchPerFileGlobals(global, baseline, undefined, BOTH)
    global.__addedByLoad = {}
    assert.equal(end(), true)
  })

  it('counts a worker key the load replaced, by assignment or by defineProperty', () => {
    for (const write of [
      (global: Record<string, unknown>) => {
        global.setTimeout = () => 1
      },
      (global: Record<string, unknown>) => {
        Object.defineProperty(global, 'setTimeout', { configurable: true, value: () => 1 })
      },
      (global: Record<string, unknown>) => {
        Object.defineProperty(global, 'setTimeout', { configurable: true, get: () => () => 1 })
      },
    ]) {
      const { global, baseline } = fileGlobal()
      const end = watchPerFileGlobals(global, baseline, undefined, WRITES)
      write(global)
      assert.equal(end(), true)
    }
  })

  it('counts an accessor given another getter, not one that settled into a data key (a lazy global)', () => {
    const { global, baseline } = fileGlobal()
    let lazy: unknown
    Object.defineProperty(global, 'LazyGlobal', {
      configurable: true,
      get() {
        lazy ??= class {}
        // Node's lazy globals replace themselves with a data key on their first read.
        Object.defineProperty(global, 'LazyGlobal', {
          configurable: true,
          writable: true,
          value: lazy,
        })
        return lazy
      },
    })
    const settles = watchPerFileGlobals(global, baseline, undefined, WRITES)
    void global.LazyGlobal
    assert.equal(settles(), false)
    const replaced = watchPerFileGlobals(global, baseline, undefined, WRITES)
    Object.defineProperty(global, 'Event', { configurable: true, get: () => class {} })
    assert.equal(replaced(), true, 'a data key made an accessor is a write')
  })

  it('says nothing when the load only read, or deleted a key', () => {
    const { global, baseline } = fileGlobal()
    const end = watchPerFileGlobals(global, baseline, undefined, WRITES)
    void global.setTimeout
    void global.expect
    delete global.afterEach
    assert.equal(end(), false)
  })

  it('with reads off, redefines no key and hears no read', () => {
    const { global, baseline } = fileGlobal()
    const before = Object.getOwnPropertyNames(global).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(global, key),
    ])
    let heard = false
    const covered: GlobalReadWatch = {
      covers: (key) => key === 'document',
      watch: () => {
        heard = true
        return () => {}
      },
    }
    const end = watchPerFileGlobals(global, baseline, covered, WRITES)
    assert.deepEqual(
      Object.getOwnPropertyNames(global).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(global, key),
      ]),
      before,
      'every descriptor is as it was while the window is open',
    )
    void global.expect
    void global.document
    assert.equal(end(), false)
    assert.equal(heard, false, 'the environment’s accessors are not listened to')
  })

  it('a write to a watched per-file key counts under both triggers, and the key is put back', () => {
    const { global, baseline } = fileGlobal()
    const end = watchPerFileGlobals(global, baseline, undefined, BOTH)
    global.expect = 'replaced'
    assert.equal(end(), true)
    assert.equal(Object.getOwnPropertyDescriptor(global, 'expect')?.value, 'replaced')
  })

  /** A lazy accessor as Node defines one: its first read loads the value and settles to a data key. */
  function lazyAccessor(global: Record<string, unknown>, key: string, load: () => unknown): void {
    let loaded: unknown
    const settle = (value: unknown): void => {
      Object.defineProperty(global, key, { configurable: true, writable: true, value })
    }
    Object.defineProperty(global, key, {
      configurable: true,
      get() {
        loaded ??= load()
        settle(loaded)
        return loaded
      },
      set: settle,
    })
  }

  it('an accessor a load replaces with its own function is a write; one that settles is not', () => {
    const settles = fileGlobal()
    // Node's own fetch is JavaScript (undici), so its source is no `[native code]`: the getter's
    // value is what tells a settle apart.
    function fetch(): string {
      return 'node'
    }
    lazyAccessor(settles.global, 'fetch', () => fetch)
    const read = watchPerFileGlobals(settles.global, settles.baseline, undefined, WRITES)
    void settles.global.fetch
    assert.equal(read(), false, 'a lazy read leaves the getter’s own value')

    const native = fileGlobal()
    lazyAccessor(native.global, 'structuredClone', () => structuredClone)
    const nativeRead = watchPerFileGlobals(native.global, native.baseline, undefined, WRITES)
    void native.global.structuredClone
    assert.equal(nativeRead(), false, 'a native function is Node’s own')

    for (const patch of [
      (global: Record<string, unknown>) => {
        global.fetch = () => 'patched'
      },
      (global: Record<string, unknown>) => {
        Object.defineProperty(global, 'fetch', { configurable: true, value: () => 'patched' })
      },
    ]) {
      const patched = fileGlobal()
      lazyAccessor(patched.global, 'fetch', () => fetch)
      const end = watchPerFileGlobals(patched.global, patched.baseline, undefined, WRITES)
      patch(patched.global)
      assert.equal(end(), true, 'a JavaScript function in the getter’s place is a patch')
    }
  })

  it('counts only what the environment’s restore takes back: a configurable or a writable key', () => {
    // `@provino/env-shared`'s `snapshotProperties.restore`: every own key, symbols included, is
    // deleted when added and redefined when changed, unless it can't be (a non-configurable key
    // added, a key made non-configurable) or is a process singleton (graceful-fs's queue,
    // undici's dispatchers).
    const write = (change: (global: Record<string | symbol, unknown>) => void): boolean => {
      const { global, baseline } = fileGlobal()
      const end = watchPerFileGlobals(global, baseline, undefined, WRITES)
      change(global)
      return end()
    }
    assert.equal(
      write((global) => {
        global[Symbol.for('provino.test.added')] = {}
      }),
      true,
      'an added symbol key is deleted by the restore',
    )
    assert.equal(
      write((global) => {
        Object.defineProperty(global, '__pinned', { configurable: false, value: 1 })
      }),
      false,
      'an added non-configurable key stays: the shared copy keeps it',
    )
    assert.equal(
      write((global) => {
        Object.defineProperty(global, Symbol.for('undici.globalDispatcher.1'), {
          configurable: false,
          value: {},
        })
        global[Symbol('graceful-fs.queue')] = []
      }),
      false,
      'a process singleton is left alone by the restore',
    )
    assert.equal(
      write((global) => {
        Object.defineProperty(global, 'setTimeout', {
          configurable: false,
          writable: false,
          value: () => 1,
        })
      }),
      false,
      'a key the load made non-configurable and read-only can’t be put back',
    )
    assert.equal(
      write((global) => {
        global.process = { replaced: true }
      }),
      true,
      'process is restored too: it is only kept out of the reads',
    )
  })

  it('reads the load’s state before the read-watched keys go back, and an equal value is no write', () => {
    const both = fileGlobal()
    const end = watchPerFileGlobals(both.global, both.baseline, undefined, BOTH)
    // A package that reads a worker key and replaces it in the same load.
    const real = both.global.setTimeout
    both.global.setTimeout = () => (typeof real === 'function' ? 2 : 0)
    assert.equal(end(), true)

    // The restore puts the value back as it is, so an assignment of the same value breaks nothing.
    const same = fileGlobal()
    const again = watchPerFileGlobals(same.global, same.baseline, undefined, WRITES)
    const { setTimeout: timer, expect: expected } = same.global
    same.global.setTimeout = timer
    same.global.expect = expected
    assert.equal(again(), false)
  })

  it('with reads off, takes only the descriptors: no baseline, no covered keys', () => {
    const { global } = fileGlobal()
    let asked = 0
    const baseline = new Proxy(new Map<string, PropertyDescriptor>(), {
      get(target, name) {
        asked++
        const value: unknown = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const covered: GlobalReadWatch = {
      covers: () => {
        asked++
        return false
      },
      watch: () => () => {},
    }
    const end = watchPerFileGlobals(global, baseline, covered, WRITES)
    global.__added = 1
    assert.equal(end(), true)
    assert.equal(asked, 0, 'neither the baseline nor the covered keys were read')
  })

  it('costs one more walk of the global per window (`local`)', () => {
    // A global of jsdom's size: about 874 own keys, a few hundred of them accessors.
    const global: Record<string, unknown> = {}
    for (let i = 0; i < 600; i++) global[`Data${i}`] = () => i
    for (let i = 0; i < 274; i++) {
      Object.defineProperty(global, `Accessor${i}`, {
        configurable: true,
        enumerable: true,
        get: () => i,
        set: () => {},
      })
    }
    const baseline = readGlobalBaseline(global)
    const covered: GlobalReadWatch = {
      covers: (key) => key.startsWith('Accessor'),
      watch: () => () => {},
    }
    const windows = 2_000
    const time = (triggers: { readonly reads: boolean; readonly writes: boolean }): number => {
      const start = process.hrtime.bigint()
      for (let i = 0; i < windows; i++) {
        const end = watchPerFileGlobals(global, baseline, covered, triggers)
        assert.equal(end(), false)
      }
      return Number(process.hrtime.bigint() - start) / 1000 / windows
    }
    // Interleaved, the first round discarded.
    const reads: number[] = []
    const writes: number[] = []
    const both: number[] = []
    for (let round = 0; round < 6; round++) {
      const a = time({ reads: true, writes: false })
      const b = time(WRITES)
      const c = time(BOTH)
      if (round > 0) {
        reads.push(a)
        writes.push(b)
        both.push(c)
      }
    }
    const median = (values: number[]): number => values.toSorted((x, y) => x - y)[2] ?? 0
    console.log(
      `local: a window over ${Object.keys(global).length} keys, reads only ${median(reads).toFixed(1)} µs, writes only ${median(writes).toFixed(1)} µs, reads and writes ${median(both).toFixed(1)} µs (median of 5 rounds of ${windows})`,
    )
  })
})

describe('adoptingGlobals', () => {
  it('takes what a once-only step installed, changed or removed into the baseline', async () => {
    const original = () => 0
    const global: Record<string, unknown> = { setTimeout: original, gone: 1, kept: 2 }
    const baseline = readGlobalBaseline(global)
    const wrapper = () => 1
    const result = await adoptingGlobals(
      baseline,
      () => {
        global.setTimeout = wrapper
        global.installed = 'worker-wide'
        delete global.gone
        return 'the step’s value'
      },
      global,
    )
    assert.equal(result, 'the step’s value')
    assert.equal(baseline.get('setTimeout')?.value, wrapper)
    assert.equal(baseline.get('installed')?.value, 'worker-wide')
    assert.equal(baseline.has('gone'), false)
    assert.equal(baseline.get('kept')?.value, 2)
    // Not a per-file global: a load that reads them reads nothing a file set up.
    assert.deepEqual(perFileKeys(global, baseline), [])
  })

  it('leaves out what a file changed before the step: only the step’s own changes', async () => {
    const global: Record<string, unknown> = { a: 1 }
    const baseline = readGlobalBaseline(global)
    global.a = 2
    await adoptingGlobals(baseline, async () => {}, global)
    assert.equal(baseline.get('a')?.value, 1)
    assert.deepEqual(
      perFileKeys(global, baseline).map(([key]) => key),
      ['a'],
    )
  })

  it('just runs the step when there is no baseline', async () => {
    let ran = false
    await adoptingGlobals(undefined, () => {
      ran = true
    })
    assert.equal(ran, true)
  })
})
