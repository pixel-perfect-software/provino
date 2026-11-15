import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
})
