// The interrupt latch over a fake session: no process and no wait.
import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import type { WatchRunOptions, WatchSession } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import { latchInterrupts } from './watch-interrupt.ts'

const OPTIONS: WatchRunOptions = { bus: createReporterBus([]) }

function fakeSession() {
  const calls: string[] = []
  let running = false
  const session: WatchSession = {
    get running() {
      return running
    },
    run: () => {
      // As the real one: the controller exists as the call returns.
      calls.push('run')
      running = true
      return new Promise(() => {})
    },
    interrupt: () => {
      calls.push('interrupt')
    },
    onChange: () => () => {},
    close: () => Promise.resolve(),
  }
  return { session, calls }
}

describe('latchInterrupts', () => {
  it('an interrupt before the session run starts is applied as it starts', () => {
    const fake = fakeSession()
    const latch = latchInterrupts(fake.session)
    latch.begin()
    latch.interrupt()
    assert.deepEqual(fake.calls, [])
    void latch.session.run(OPTIONS)
    assert.deepEqual(fake.calls, ['run', 'interrupt'])
  })

  it('an interrupt during the session run goes straight to it', () => {
    const fake = fakeSession()
    const latch = latchInterrupts(fake.session)
    latch.begin()
    void latch.session.run(OPTIONS)
    latch.interrupt()
    assert.deepEqual(fake.calls, ['run', 'interrupt'])
  })

  it('an interrupt after the host run is over is dropped', () => {
    const fake = fakeSession()
    const latch = latchInterrupts(fake.session)
    latch.begin()
    latch.end()
    latch.interrupt()
    latch.begin()
    void latch.session.run(OPTIONS)
    assert.deepEqual(fake.calls, ['run'])
  })

  it('a pending interrupt does not outlive its run', () => {
    const fake = fakeSession()
    const latch = latchInterrupts(fake.session)
    latch.begin()
    latch.interrupt()
    latch.end()
    latch.begin()
    void latch.session.run(OPTIONS)
    assert.deepEqual(fake.calls, ['run'])
  })
})
