// `handleSignals`: SIGINT, SIGTERM and SIGHUP as the run's two signals, over a stand-in for
// `process`.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { type HandledSignal, handleSignals, type SignalTarget } from './signals.ts'

const ALL: readonly HandledSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** An emitter that is a `SignalTarget`, with the listener count the bin's cleanup is held to. */
function target(): SignalTarget & { emit(event: HandledSignal): void; listeners(): number } {
  const emitter = new EventEmitter()
  return {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    emit: (event) => void emitter.emit(event),
    listeners: () => ALL.reduce((count, event) => count + emitter.listenerCount(event), 0),
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

  it('aborts it with "SIGHUP" on the first SIGHUP, and exit code 129 (128 + 1)', () => {
    const process = target()
    const control = handleSignals(process)
    process.emit('SIGHUP')
    assert.equal(control.signal.aborted, true)
    assert.equal(control.signal.reason, 'SIGHUP')
    assert.equal(control.forceSignal.aborted, false)
    assert.equal(control.exitCode(), 129)
  })

  it('tells onFirst the exit code as the first signal lands, before anything else is done, and only then', () => {
    for (const [name, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const process = target()
      const heard: number[] = []
      let abortedWhenTold: boolean | undefined
      const control = handleSignals(process, {
        onFirst: (exitCode) => {
          heard.push(exitCode)
          abortedWhenTold = control.signal.aborted
        },
      })
      process.emit(name)
      process.emit(name)
      process.emit('SIGINT')
      assert.deepEqual(heard, [code], `${name}: told once`)
      assert.equal(abortedWhenTold, false, 'the exit code is known before the abort is delivered')
    }
  })

  it('forces on the second signal, of any kind, and keeps the first one’s exit code', () => {
    for (const [first, second, code] of [
      ['SIGINT', 'SIGINT', 130],
      ['SIGINT', 'SIGTERM', 130],
      ['SIGTERM', 'SIGINT', 143],
      ['SIGTERM', 'SIGTERM', 143],
      ['SIGHUP', 'SIGHUP', 129],
      ['SIGHUP', 'SIGINT', 129],
      ['SIGINT', 'SIGHUP', 130],
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
    assert.equal(process.listeners(), 3)
    control.dispose()
    assert.equal(process.listeners(), 0)
    process.emit('SIGINT')
    assert.equal(control.signal.aborted, false)
  })
})
