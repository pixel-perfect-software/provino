// `handleSignals`: SIGINT and SIGTERM as the run's two signals, over a stand-in for `process`.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { handleSignals, type SignalTarget } from './signals.ts'

/** An emitter that is a `SignalTarget`, with the listener count the bin's cleanup is held to. */
function target(): SignalTarget & { emit(event: 'SIGINT' | 'SIGTERM'): void; listeners(): number } {
  const emitter = new EventEmitter()
  return {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    emit: (event) => void emitter.emit(event),
    listeners: () => emitter.listenerCount('SIGINT') + emitter.listenerCount('SIGTERM'),
  }
}

describe('handleSignals', () => {
  it('aborts the run with the signal’s name on the first SIGINT, and exit code 130', () => {
    const process = target()
    const control = handleSignals(process)
    assert.equal(control.signal.aborted, false)
    assert.equal(control.exitCode(), undefined)
    process.emit('SIGINT')
    assert.equal(control.signal.aborted, true)
    assert.equal(control.signal.reason, 'SIGINT')
    assert.equal(control.forceSignal.aborted, false, 'one signal is not a force')
    assert.equal(control.exitCode(), 130)
  })

  it('aborts it with "SIGTERM" on the first SIGTERM, and exit code 143', () => {
    const process = target()
    const control = handleSignals(process)
    process.emit('SIGTERM')
    assert.equal(control.signal.reason, 'SIGTERM')
    assert.equal(control.forceSignal.aborted, false)
    assert.equal(control.exitCode(), 143)
  })

  it('forces on the second signal, of either kind, and keeps the first one’s exit code', () => {
    for (const [first, second, code] of [
      ['SIGINT', 'SIGINT', 130],
      ['SIGINT', 'SIGTERM', 130],
      ['SIGTERM', 'SIGINT', 143],
      ['SIGTERM', 'SIGTERM', 143],
    ] as const) {
      const process = target()
      let forced = 0
      const control = handleSignals(process, { onForce: () => void forced++ })
      process.emit(first)
      process.emit(second)
      assert.equal(control.forceSignal.aborted, true, `${first} then ${second}`)
      assert.equal(control.forceSignal.reason, second)
      assert.equal(control.signal.reason, first, 'the run was cut short by the first')
      assert.equal(control.exitCode(), code)
      process.emit(second)
      assert.equal(forced, 1, 'onForce runs once, however many signals follow')
    }
  })

  it('stops listening on dispose, so a later signal takes the default action', () => {
    const process = target()
    const control = handleSignals(process)
    assert.equal(process.listeners(), 2)
    control.dispose()
    assert.equal(process.listeners(), 0)
    process.emit('SIGINT')
    assert.equal(control.signal.aborted, false)
  })
})
