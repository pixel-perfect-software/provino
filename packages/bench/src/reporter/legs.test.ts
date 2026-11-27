import assert from 'node:assert/strict'
import { test } from 'provino'
import { runSlowSinkLeg } from './legs.ts'
import type { PaceClock } from './pace.ts'
import { buildStream, specForTests } from './stream.ts'

const TESTS = 400
const BATCH_MS = 10

/** A clock the test moves: a sleep of `ms` takes exactly `ms`, a turn takes none. No real time passes. */
function fakeClock(): PaceClock {
  let time = 0
  return {
    now: () => time,
    sleep(ms) {
      time += ms
      return Promise.resolve()
    },
    yieldTurn: () => Promise.resolve(),
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
  // 190 ms in, so the clock reads 190 ms there and the events per second are exactly the stream's
  // events (less run:end) over that. No real time passes, so no load changes the answer.
  const events = buildStream(specForTests(TESTS)).events.length - 1
  const durationMs = (TESTS / 2000) * 1000
  const lastBatchMs = durationMs - BATCH_MS
  const result = await runSlowSinkLeg(TESTS, 1, 2000, 0, fakeClock())
  for (const perSec of [result.fastPerSec, result.slowPerSec]) {
    assert.ok(
      Math.abs(perSec - (events / lastBatchMs) * 1000) < 1e-6,
      `${perSec} events a second is not paced`,
    )
  }
})
