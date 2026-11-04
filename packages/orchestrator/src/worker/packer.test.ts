// The packer's rules, with a recording `send`: cut at 64 events or the end of the macrotask, at
// most 8 packs unacked, cumulative acks, nothing lost or reordered, and `flush` covering everything
// emitted before it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskId, WorkerEvent } from '@provino/types'
import { createPacker, type PackMessage } from './packer.ts'

const event = (n: number): WorkerEvent => ({ type: 'test-start', id: `t${n}` as TaskId, t: n })
const ids = (packs: readonly PackMessage[]): string[] =>
  packs.flatMap((pack) => pack.events.map((e) => (e as { id: string }).id))
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('createPacker', () => {
  it('cuts a pack at 64 events, synchronously', () => {
    const sent: PackMessage[] = []
    const packer = createPacker((m) => sent.push(m))
    for (let i = 0; i < 130; i++) packer.emit(event(i))
    assert.deepEqual(
      sent.map((p) => [p.pack, p.events.length]),
      [
        [0, 64],
        [1, 64],
      ],
    )
  })

  it('cuts what is left at the end of the macrotask', async () => {
    const sent: PackMessage[] = []
    const packer = createPacker((m) => sent.push(m))
    packer.emit(event(0))
    await Promise.resolve()
    packer.emit(event(1))
    assert.equal(sent.length, 0, 'microtasks stay in the same pack')
    await nextMacrotask()
    assert.deepEqual(ids(sent), ['t0', 't1'])
    assert.equal(sent.length, 1)
  })

  it('holds packs beyond 8 unacked, in order, and sends them as acks arrive', () => {
    const sent: PackMessage[] = []
    const packer = createPacker((m) => sent.push(m))
    for (let i = 0; i < 64 * 12; i++) packer.emit(event(i))
    assert.equal(sent.length, 8)
    assert.equal(packer.inFlight, 8)
    packer.ack(0)
    assert.equal(sent.length, 9)
    packer.ack(2) // cumulative: 1 and 2 as well
    assert.equal(sent.length, 11)
    packer.ack(1) // stale
    assert.equal(sent.length, 11)
    packer.ack(10)
    assert.equal(sent.length, 12)
    assert.equal(packer.inFlight, 1)
    assert.deepEqual(
      sent.map((p) => p.pack),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    )
    assert.deepEqual(
      ids(sent),
      Array.from({ length: 64 * 12 }, (_, i) => `t${i}`),
    )
  })

  it('ignores an ack for a pack it never sent', () => {
    const sent: PackMessage[] = []
    const packer = createPacker((m) => sent.push(m), { maxEvents: 1, maxPacksInFlight: 2 })
    packer.emit(event(0))
    packer.ack(50)
    assert.equal(packer.inFlight, 0)
    for (let i = 1; i < 4; i++) packer.emit(event(i))
    assert.equal(sent.length, 3, 'the window counts from the packs actually sent')
  })

  it('flush resolves once everything emitted before it is sent, waiting for acks', async () => {
    const sent: PackMessage[] = []
    const packer = createPacker((m) => sent.push(m), { maxPacksInFlight: 2 })
    for (let i = 0; i < 64 * 3 + 5; i++) packer.emit(event(i))
    let flushed = false
    const flush = packer.flush().then(() => {
      flushed = true
    })
    packer.emit(event(9999)) // after the flush: not waited for
    await Promise.resolve()
    assert.equal(flushed, false)
    assert.equal(sent.length, 2)
    packer.ack(1)
    await flush
    assert.equal(sent.length, 4)
    assert.equal(ids(sent).length, 64 * 3 + 5)
    await nextMacrotask()
    assert.equal(sent.length, 4, 'the later pack waits: the window is full again')
    packer.ack(3)
    assert.deepEqual(ids(sent).at(-1), 't9999')
  })

  it('flush with nothing buffered resolves at once', async () => {
    const packer = createPacker(() => assert.fail('nothing to send'))
    await packer.flush()
  })

  it('writable waits while the window is full', async () => {
    const packer = createPacker(() => {}, { maxEvents: 1, maxPacksInFlight: 1 })
    await packer.writable()
    packer.emit(event(0))
    let open = false
    const writable = packer.writable().then(() => {
      open = true
    })
    await Promise.resolve()
    assert.equal(open, false)
    packer.ack(0)
    await writable
    assert.equal(open, true)
  })

  it('can cut on an interval instead (Track 9’s 100 ms rule), not at the macrotask', async () => {
    const sent: PackMessage[] = []
    const packer = createPacker((m) => sent.push(m), { schedule: { intervalMs: 60_000 } })
    packer.emit(event(0))
    await nextMacrotask()
    packer.emit(event(1))
    await nextMacrotask()
    assert.equal(sent.length, 0, 'the macrotask boundary does not cut')
    await packer.flush() // cuts now, and clears the interval timer
    assert.deepEqual(ids(sent), ['t0', 't1'])
  })

  it('reports a pack it can’t send in place of the unsendable events, and never throws', async () => {
    const sent: PackMessage[] = []
    // Like a port or advanced IPC: any event carrying a function fails the whole send.
    const send = (message: PackMessage): void => {
      if (message.events.some((e) => typeof (e as { message?: unknown }).message === 'function')) {
        throw new Error('() => 1 could not be cloned.')
      }
      sent.push(message)
    }
    const packer = createPacker(send, { maxEvents: 3 })
    const bad = {
      type: 'annotation',
      testId: 'x',
      message: () => 1,
      kind: 'k',
      location: null,
      t: 5,
    } as unknown as WorkerEvent
    assert.doesNotThrow(() => {
      packer.emit(event(0))
      packer.emit(bad)
      packer.emit(event(2)) // the third event cuts the pack, inside emit
    })
    packer.emit(event(3))
    await packer.flush()
    assert.deepEqual(
      sent.map((p) => p.pack),
      [0, 1],
      'pack numbers stay contiguous',
    )
    const first = sent[0]?.events ?? []
    assert.deepEqual(
      first.map((e) => e.type),
      ['test-start', 'unhandled-error', 'test-start'],
    )
    const report = first[1] as Extract<WorkerEvent, { type: 'unhandled-error' }>
    assert.match(report.error.message, /annotation event couldn’t be sent/)
    assert.equal(packer.inFlight, 2)
  })
})
