import assert from 'node:assert/strict'
import { test } from 'provino'
import { runSlowSinkLeg } from './legs.ts'

// 400 tests (16 files) at 20,000 a second: a replay of about 20 ms, so the test waits on no real time worth naming.
const TESTS = 400
const RATE = 20_000

test('the paced slow-sink leg reports throughput and each event wait for both sinks', async () => {
  const result = await runSlowSinkLeg(TESTS, 1, RATE, 0)
  assert.equal(result.testsPerSec, RATE)
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
  // 400 tests at 2,000 a second is 200 ms: the events per second must be about the stream's events over that.
  const result = await runSlowSinkLeg(TESTS, 1, 2000, 0)
  assert.ok(result.fastPerSec < 40_000, `${result.fastPerSec} events a second is not paced`)
  assert.ok(result.fastPerSec > 5_000)
})
