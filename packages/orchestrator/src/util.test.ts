import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { describe, it } from 'node:test'
import { ABORTED, isRecord, raceAbort } from './util.ts'

/** How many `abort` listeners a signal holds (`events.getEventListeners` is the public way to see them). */
function listenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, 'abort').length
}

describe('raceAbort', () => {
  it('resolves with the work’s value when it settles first, and leaves no listener behind', async () => {
    const controller = new AbortController()
    const work = Promise.resolve('done')
    assert.equal(await raceAbort(work, controller.signal), 'done')
    assert.equal(listenerCount(controller.signal), 0)
  })

  it('rejects with what the work threw, and leaves no listener behind', async () => {
    const controller = new AbortController()
    await assert.rejects(raceAbort(Promise.reject(new Error('boom')), controller.signal), {
      message: 'boom',
    })
    assert.equal(listenerCount(controller.signal), 0)
  })

  it('resolves with ABORTED as the signal aborts, though the work never settles', async () => {
    const controller = new AbortController()
    const race = raceAbort(new Promise(() => {}), controller.signal)
    assert.equal(listenerCount(controller.signal), 1)
    controller.abort('SIGINT')
    assert.equal(await race, ABORTED)
    assert.equal(listenerCount(controller.signal), 0)
  })

  it('resolves with ABORTED at once for a signal that has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    assert.equal(await raceAbort(new Promise(() => {}), controller.signal), ABORTED)
    assert.equal(listenerCount(controller.signal), 0)
  })

  it('swallows what the abandoned work throws later: it is nobody’s to report', async () => {
    const controller = new AbortController()
    let fail: (reason: unknown) => void = () => {}
    const work = new Promise<never>((_resolve, reject) => {
      fail = reject
    })
    const race = raceAbort(work, controller.signal)
    controller.abort()
    assert.equal(await race, ABORTED)
    // No `unhandledRejection` reaches the process: node:test would fail this test for one.
    fail(new Error('too late'))
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('races an AbortSignal.any of several', async () => {
    const first = new AbortController()
    const second = new AbortController()
    const race = raceAbort(new Promise(() => {}), AbortSignal.any([first.signal, second.signal]))
    second.abort()
    assert.equal(await race, ABORTED)
  })
})

describe('isRecord', () => {
  it('is an object that is neither null nor an array', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord(Object.create(null)), true)
    assert.equal(isRecord(null), false)
    assert.equal(isRecord([]), false)
    assert.equal(isRecord('text'), false)
    assert.equal(
      isRecord(() => {}),
      false,
    )
  })
})
