import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeClock } from '../test-support.ts'
import { createFrameScheduler, createImmediateFlusher } from './scheduler.ts'

function make(frameResult: () => number | undefined = () => undefined) {
  const clock = fakeClock()
  const frames: number[] = []
  const scheduler = createFrameScheduler({ now: clock.now, timers: clock.timers })
  scheduler.bind(() => {
    frames.push(clock.now())
    return frameResult()
  })
  return { clock, frames, scheduler }
}

test('the first request draws on the next turn, not synchronously', () => {
  const { clock, frames, scheduler } = make()
  scheduler.request()
  assert.equal(frames.length, 0)
  clock.advance(0)
  assert.deepEqual(frames, [0])
})

test('at most one frame per interval, however many requests', () => {
  const { clock, frames, scheduler } = make()
  scheduler.request()
  clock.advance(0)
  for (let i = 0; i < 100; i++) {
    scheduler.request()
    clock.advance(1)
  }
  // 100 requests over 100 ms: a frame at 0 and the next at 60.
  assert.deepEqual(frames, [0, 60])
})

test('no request, no timer, no frame', () => {
  const { clock, frames } = make()
  clock.advance(10_000)
  assert.equal(frames.length, 0)
  assert.equal(clock.pending(), 0)
})

test('a frame that wants a spinner tick comes every second 60 ms tick, until nothing is wanted', () => {
  let ticks = 0
  const { clock, frames, scheduler } = make(() => (++ticks < 4 ? 120 : undefined))
  scheduler.request()
  clock.advance(600)
  assert.deepEqual(frames, [0, 120, 240, 360])
  assert.equal(clock.pending(), 0)
  scheduler.request()
  clock.advance(0)
  assert.deepEqual(frames.slice(4), [600])
})

test('a request while a spinner wait is pending brings the frame forward to the interval', () => {
  const { clock, frames, scheduler } = make(() => 120)
  scheduler.request()
  clock.advance(0)
  clock.advance(10)
  scheduler.request()
  clock.advance(49)
  assert.deepEqual(frames, [0])
  clock.advance(1)
  assert.deepEqual(frames, [0, 60])
})

test('a slow terminal backs the interval off to 100 times the write time, capped at 2 s', () => {
  const { clock, frames, scheduler } = make()
  scheduler.observeWrite(5)
  scheduler.request()
  clock.advance(0)
  scheduler.request()
  clock.advance(499)
  assert.deepEqual(frames, [0])
  clock.advance(1)
  assert.deepEqual(frames, [0, 500])

  const slow = make()
  slow.scheduler.observeWrite(100)
  slow.scheduler.request()
  slow.clock.advance(0)
  slow.scheduler.request()
  slow.clock.advance(1999)
  assert.equal(slow.frames.length, 1)
  slow.clock.advance(1)
  assert.deepEqual(slow.frames, [0, 2000])
})

test('the write time is an average: one fast write does not undo a slow terminal', () => {
  const { clock, frames, scheduler } = make()
  scheduler.observeWrite(5)
  scheduler.observeWrite(0)
  scheduler.request()
  clock.advance(0)
  scheduler.request()
  clock.advance(350)
  assert.deepEqual(frames, [0, 350])
})

test('the timer is unref()d, so it never keeps the process alive', () => {
  const { clock, scheduler } = make(() => 120)
  scheduler.request()
  clock.advance(0)
  clock.advance(120)
  assert.ok(clock.unrefs() >= 3)
})

test('stop cancels the pending frame and later requests do nothing, until bind', () => {
  const { clock, frames, scheduler } = make()
  scheduler.request()
  scheduler.stop()
  assert.equal(clock.pending(), 0)
  scheduler.request()
  clock.advance(1000)
  assert.equal(frames.length, 0)
  scheduler.bind(() => {
    frames.push(1)
    return undefined
  })
  scheduler.request()
  clock.advance(1)
  assert.deepEqual(frames, [1])
})

test('the immediate flusher runs once per turn however often it is scheduled', () => {
  const queue: (() => void)[] = []
  let flushes = 0
  const flusher = createImmediateFlusher(
    () => {
      flushes++
    },
    (callback) => queue.push(callback),
  )
  flusher.schedule()
  flusher.schedule()
  flusher.schedule()
  assert.equal(queue.length, 1)
  queue.shift()?.()
  assert.equal(flushes, 1)
  flusher.schedule()
  assert.equal(queue.length, 1)
})

test('flushNow runs the flush and cancels the one arranged', () => {
  const queue: (() => void)[] = []
  let flushes = 0
  const flusher = createImmediateFlusher(
    () => {
      flushes++
    },
    (callback) => queue.push(callback),
  )
  flusher.schedule()
  flusher.flushNow()
  assert.equal(flushes, 1)
  queue.shift()?.()
  assert.equal(flushes, 1)
})
