import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { GlobalReadWatch } from '@provino/types'
import { perFileKeys, readGlobalBaseline, watchPerFileGlobals } from './external-probe.ts'

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

  it('still watches a covered key the file redefined since', () => {
    const { global, baseline } = fileGlobal()
    const covered: GlobalReadWatch = { covers: () => false, watch: () => () => {} }
    const end = watchPerFileGlobals(global, baseline, covered)
    void global.document
    assert.equal(end(), true)
  })
})
