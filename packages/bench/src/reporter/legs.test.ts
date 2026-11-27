import assert from 'node:assert/strict'
import { test } from 'provino'
import { BATCH_MS, runSlowSinkLeg } from './legs.ts'
import { type PaceClock, waitUntil } from './pace.ts'
import { buildStream, specForTests } from './stream.ts'

const TESTS = 400

/**
 * A clock the test moves: a sleep of `ms` takes exactly `ms`, a turn takes none. No real time
 * passes. A wait that only turns (a due time under 1 ms ahead) would never end, so a long run of
 * turns with no sleep between them throws: the test fails instead of hanging.
 */
function fakeClock(): PaceClock {
  const MAX_TURNS = 1000
  let time = 0
  let turns = 0
  return {
    now: () => time,
    sleep(ms) {
      time += ms
      turns = 0
      return Promise.resolve()
    },
    yieldTurn() {
      if (++turns > MAX_TURNS) throw new Error('the fake clock never reached the due time')
      return Promise.resolve()
    },
  }
}

test('the paced slow-sink leg reports throughput and each event wait for both sinks', async () => {
  const rate = 20_000
  const result = await runSlowSinkLeg(TESTS, 1, rate, 0, fakeClock())
  assert.equal(result.testsPerSec, rate)
  assert.equal(result.slowWriteMs, 0)
  assert.equal(result.rounds, 1)
  for (const value of [
    result.fastPerSec,
    result.slowPerSec,
    result.ratio,
    result.ratioWithEnd,
    result.fastWaitMedianMs,
    result.fastWaitP99Ms,
    result.slowWaitMedianMs,
    result.slowWaitP99Ms,
  ]) {
    assert.ok(Number.isFinite(value) && value >= 0)
  }
  assert.ok(result.fastWaitP99Ms >= result.fastWaitMedianMs)
  assert.ok(result.slowWaitP99Ms >= result.slowWaitMedianMs)
})

test('the replay takes the time its rate says, whatever the sink', async () => {
  // 400 tests at 2,000 a second is 200 ms: the last event before run:end goes in the batch due
  // 190 ms in, so the clock reads 190 ms there and the events per second are the stream's events
  // (less run:end) over that, to within rounding. No real time passes, so no load changes the answer.
  const rate = 2000
  const eventsBeforeEnd = buildStream(specForTests(TESTS)).events.length - 1
  const lastBatchMs = (TESTS / rate) * 1000 - BATCH_MS
  const result = await runSlowSinkLeg(TESTS, 1, rate, 0, fakeClock())
  for (const perSec of [result.fastPerSec, result.slowPerSec]) {
    assert.ok(
      Math.abs(perSec - (eventsBeforeEnd / lastBatchMs) * 1000) < 1e-6,
      `${perSec} events a second is not paced`,
    )
  }
})

test('a due time under a millisecond ahead fails the fake clock instead of hanging', async () => {
  await assert.rejects(waitUntil(0.5, fakeClock()), /never reached the due time/)
})

test('a slow sink on a fake clock is refused', async () => {
  await assert.rejects(runSlowSinkLeg(TESTS, 1, 2000, 5, fakeClock()), RangeError)
})
