// The coalescer over a fake clock: the window, the repeats, the unmoved mtime, close.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type CoalesceClock, createCoalescer, type WatchEvent } from './coalesce.ts'

/** A clock whose timers fire only when the test says so. */
function fakeClock(): CoalesceClock & {
  readonly pending: () => readonly number[]
  readonly fire: () => void
} {
  let timers: { readonly ms: number; readonly callback: () => void }[] = []
  return {
    schedule(callback, ms) {
      const timer = { ms, callback }
      timers.push(timer)
      return () => {
        timers = timers.filter((other) => other !== timer)
      }
    },
    pending: () => timers.map((timer) => timer.ms),
    fire() {
      const due = timers
      timers = []
      for (const timer of due) timer.callback()
    },
  }
}

const event = (kind: WatchEvent['kind'], path: string, mtimeMs?: number): WatchEvent => ({
  kind,
  path,
  mtimeMs,
})

function setup(known?: ReadonlyMap<string, number>) {
  const clock = fakeClock()
  const batches: (readonly WatchEvent[])[] = []
  const coalescer = createCoalescer({
    emit: (batch) => batches.push(batch),
    clock,
    ...(known === undefined ? {} : { known }),
  })
  return { clock, batches, coalescer }
}

test('the first event opens one 30 ms window, and the events in it are one batch in order', () => {
  const { clock, batches, coalescer } = setup()
  coalescer.push(event('change', '/p/a.ts', 1))
  assert.deepEqual(clock.pending(), [30])
  coalescer.push(event('add', '/p/b.ts', 2))
  assert.deepEqual(clock.pending(), [30], 'a later event does not stretch the window')
  assert.deepEqual(batches, [])
  clock.fire()
  assert.deepEqual(batches, [[event('change', '/p/a.ts', 1), event('add', '/p/b.ts', 2)]])
  coalescer.push(event('change', '/p/a.ts', 3))
  clock.fire()
  assert.equal(batches.length, 2, 'the next event opens a new window')
})

test('a repeat of one kind, path and mtime is dropped within a window, and kept in the next', () => {
  const { clock, batches, coalescer } = setup()
  coalescer.push(event('add', '/p/a.ts', 1))
  coalescer.push(event('add', '/p/a.ts', 1))
  coalescer.push(event('unlink', '/p/b.ts'))
  coalescer.push(event('unlink', '/p/b.ts'))
  clock.fire()
  assert.deepEqual(batches, [[event('add', '/p/a.ts', 1), event('unlink', '/p/b.ts')]])
  coalescer.push(event('unlink', '/p/b.ts'))
  clock.fire()
  assert.deepEqual(batches[1], [event('unlink', '/p/b.ts')])
})

test('a change whose mtime has not moved is an access, and is dropped', () => {
  const { clock, batches, coalescer } = setup(new Map([['/p/a.ts', 5]]))
  coalescer.push(event('change', '/p/a.ts', 5))
  assert.deepEqual(clock.pending(), [], 'nothing to emit, no window')
  coalescer.push(event('change', '/p/a.ts', 6))
  clock.fire()
  coalescer.push(event('change', '/p/a.ts', 6))
  assert.deepEqual(clock.pending(), [], 'the mtime the last change gave is known')
  coalescer.push(event('unlink', '/p/a.ts'))
  coalescer.push(event('add', '/p/a.ts', 6))
  clock.fire()
  assert.deepEqual(batches, [
    [event('change', '/p/a.ts', 6)],
    [event('unlink', '/p/a.ts'), event('add', '/p/a.ts', 6)],
  ])
})

test('flush emits at once, and close drops what waits and ignores what comes after', () => {
  const { clock, batches, coalescer } = setup()
  coalescer.push(event('change', '/p/a.ts', 1))
  coalescer.flush()
  assert.deepEqual(clock.pending(), [], 'the window is cancelled')
  assert.equal(batches.length, 1)
  coalescer.flush()
  assert.equal(batches.length, 1, 'an empty flush emits nothing')
  coalescer.push(event('change', '/p/a.ts', 2))
  coalescer.close()
  assert.deepEqual(clock.pending(), [])
  coalescer.push(event('change', '/p/a.ts', 3))
  coalescer.flush()
  assert.equal(batches.length, 1)
})
