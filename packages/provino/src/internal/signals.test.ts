// `handleSignals`: the signals of `RUN_SIGNALS` as the run's two signals, over a stand-in for
// `process`.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { RUN_SIGNALS } from '@provino/orchestrator'
import { type HandledSignal, handleSignals, type SignalTarget } from './signals.ts'

const ALL = Object.keys(RUN_SIGNALS) as readonly HandledSignal[]

/** Every signal with the exit code a process that one ended has: 128 plus its number. */
const EXIT_CODES = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const

/** An emitter that is a `SignalTarget`, with the listener count the bin's cleanup is held to. */
function target(): SignalTarget & { emit(event: HandledSignal): void; listeners(): number } {
  const emitter = new EventEmitter()
  return {
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    emit: (event) => void emitter.emit(event),
    listeners: () => ALL.reduce((count, event) => count + emitter.listenerCount(event), 0),
  }
}

describe('handleSignals', () => {
  it('handles every signal the orchestrator names, and no other', () => {
    assert.deepEqual(EXIT_CODES.map(([name]) => name).sort(), [...ALL].sort())
  })

  for (const [name, code] of EXIT_CODES) {
    it(`aborts the run with "${name}" as the reason on the first ${name}, exit code ${code}`, () => {
      const process = target()
      const control = handleSignals(process)
      assert.equal(control.signal.aborted, false)
      assert.equal(control.exitCode(), undefined)
      process.emit(name)
      assert.equal(control.signal.aborted, true)
      assert.equal(control.signal.reason, name)
      assert.equal(control.forceSignal.aborted, false, 'one signal is not a force')
      assert.equal(control.exitCode(), code)
    })

    it(`tells onFirst ${code} as the first ${name} lands, before the abort is delivered, and only then`, () => {
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
      assert.deepEqual(heard, [code])
      assert.equal(abortedWhenTold, false, 'the exit code is known before the abort is delivered')
    })

    it(`ends the process at once with ${code} for a ${name} after the run (afterRun), by its own code`, () => {
      const process = target()
      const exited: number[] = []
      const control = handleSignals(process, { exit: (exitCode) => void exited.push(exitCode) })
      control.afterRun()
      assert.equal(
        process.listeners(),
        ALL.length,
        'one handler for each signal, none of the run’s',
      )
      process.emit(name)
      assert.deepEqual(exited, [code])
      assert.equal(control.signal.aborted, false, 'the run is over: nothing is aborted')
    })
  }

  it('forces on the second signal, of any kind, and keeps the first one’s exit code', () => {
    for (const [first, firstCode] of EXIT_CODES) {
      for (const [second] of EXIT_CODES) {
        const process = target()
        let forced = 0
        const control = handleSignals(process, { onForce: () => void forced++ })
        process.emit(first)
        process.emit(second)
        assert.equal(control.forceSignal.aborted, true, `${first} then ${second}`)
        assert.equal(control.forceSignal.reason, second)
        assert.equal(control.signal.reason, first, 'the run was cut short by the first')
        assert.equal(control.exitCode(), firstCode)
        process.emit(second)
        assert.equal(forced, 1, 'onForce runs once, however many signals follow')
      }
    }
  })

  it('stops listening on dispose, so a later signal takes the default action', () => {
    const process = target()
    const control = handleSignals(process)
    assert.equal(process.listeners(), ALL.length)
    control.dispose()
    assert.equal(process.listeners(), 0)
    process.emit('SIGINT')
    assert.equal(control.signal.aborted, false)
  })
})
