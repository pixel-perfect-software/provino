// The links' shared contract: queue until the first listener, close once, drop sends after close.
// Fork and thread links run for real in @provino/orchestrator's transport tests.
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { describe, it } from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import type { LinkClosed } from '@provino/types'
import { RpcError } from './errors.ts'
import { childProcessLink, messagePortLink, processLink } from './links.ts'

describe('messagePortLink', () => {
  it('queues messages that arrive before the first listener, in order', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = messagePortLink<{ n: number }, { n: number }>(port1)
    const b = messagePortLink<{ n: number }, { n: number }>(port2)
    for (let i = 0; i < 5; i++) a.send({ n: i })
    // Let the messages arrive with nobody listening.
    await new Promise((resolve) => setImmediate(resolve))
    const seen: number[] = []
    const done = new Promise<void>((resolve) => {
      b.onMessage(({ n }) => {
        seen.push(n)
        if (n === 5) resolve()
      })
    })
    assert.deepEqual(seen, [], 'queued messages are delivered after onMessage returns')
    a.send({ n: 5 })
    await done
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5])
    a.close()
  })

  it('queues again while nobody listens, so a listener that leaves loses nothing', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = messagePortLink<{ n: number }, { n: number }>(port1)
    const b = messagePortLink<{ n: number }, { n: number }>(port2)
    for (let i = 0; i < 4; i++) a.send({ n: i })
    const first = await new Promise<number>((resolve) => {
      const off = b.onMessage(({ n }) => {
        off()
        resolve(n)
      })
    })
    assert.equal(first, 0)
    await new Promise((resolve) => setImmediate(resolve))
    const rest: number[] = []
    await new Promise<void>((resolve) => {
      b.onMessage(({ n }) => {
        rest.push(n)
        if (n === 3) resolve()
      })
    })
    assert.deepEqual(rest, [1, 2, 3])
    a.close()
  })

  it('closes both ends once, and calls a late exit listener at once', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = messagePortLink<{ n: number }, { n: number }>(port1)
    const b = messagePortLink<{ n: number }, { n: number }>(port2)
    const exits: LinkClosed[] = []
    a.onExit((cause) => exits.push(cause))
    const bClosed = new Promise<LinkClosed>((resolve) => b.onExit(resolve))
    a.close()
    a.close()
    assert.deepEqual(await bClosed, { type: 'closed' })
    assert.deepEqual(exits, [{ type: 'closed' }])
    let late: LinkClosed | undefined
    b.onExit((cause) => {
      late = cause
    })
    assert.deepEqual(late, { type: 'closed' })
    assert.doesNotThrow(() => a.send({ n: 1 }), 'a send after close is dropped')
  })
})

/** A stand-in for a forked child: an emitter with `send`, `connected` and `disconnect`. */
class FakeChild extends EventEmitter {
  connected = true
  readonly sent: unknown[] = []
  /** Write callbacks not called yet, when the test holds writes back. */
  readonly unwritten: (() => void)[] = []
  holdWrites = false
  send(message: unknown, ...rest: unknown[]): boolean {
    // Like advanced serialization: a function can't be written, and the send throws.
    if (typeof (message as { fn?: unknown })?.fn === 'function') {
      throw new Error('() => {} could not be cloned.')
    }
    this.sent.push(message)
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined
    if (callback !== undefined) {
      if (this.holdWrites) this.unwritten.push(callback)
      else callback()
    }
    return true
  }
  disconnect(): void {
    this.connected = false
    queueMicrotask(() => this.emit('disconnect'))
  }
}

describe('every link', () => {
  it('drops a message that is not an object, which no protocol message can be', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = messagePortLink<unknown, unknown>(port1)
    const b = messagePortLink<unknown, { readonly t: string }>(port2)
    const seen: unknown[] = []
    const done = new Promise<void>((resolve) => {
      b.onMessage((message) => {
        seen.push(message.t)
        if (message.t === 'last') resolve()
      })
    })
    for (const junk of [null, 1, 'text', undefined, true]) a.send(junk)
    a.send({ t: 'last' })
    await done
    assert.deepEqual(seen, ['last'])
    a.close()
  })

  it('drops a child’s non-object message too', async () => {
    const child = new FakeChild()
    const link = childProcessLink<unknown, { readonly t: string }>(child as unknown as ChildProcess)
    const seen: string[] = []
    link.onMessage((message) => seen.push(message.t))
    child.emit('message', null)
    child.emit('message', { t: 'ok' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, ['ok'])
  })
})

describe('childProcessLink and processLink', () => {
  it('sends while connected, closes on disconnect (not exit), and drops later sends', async () => {
    const child = new FakeChild()
    const link = childProcessLink<{ m: string }, { m: string }>(child as unknown as ChildProcess)
    link.send({ m: 'a' })
    const seen: string[] = []
    link.onMessage(({ m }) => seen.push(m))
    child.emit('message', { m: 'from-child' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, ['from-child'])
    let closed = false
    link.onExit(() => {
      closed = true
    })
    child.emit('exit', 1, null)
    child.emit('message', { m: 'after-exit' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'a message can still follow exit')
    assert.deepEqual(seen, ['from-child', 'after-exit'])
    child.connected = false
    child.emit('disconnect')
    assert.equal(closed, true)
    link.send({ m: 'b' })
    assert.deepEqual(child.sent, [{ m: 'a' }])
  })

  it('closing a child-side link disconnects the IPC channel', async () => {
    const proc = new FakeChild()
    const link = processLink<string, string>(proc as unknown as NodeJS.Process)
    link.send('hello')
    link.close()
    await once(proc, 'disconnect')
    assert.equal(proc.connected, false)
    assert.deepEqual(proc.sent, ['hello'])
  })

  it('disconnects only after every send so far has been written', async () => {
    const proc = new FakeChild()
    proc.holdWrites = true
    const link = processLink<string, string>(proc as unknown as NodeJS.Process)
    link.send('last words')
    link.close()
    assert.equal(proc.connected, true, 'a write is still queued')
    for (const written of proc.unwritten.splice(0)) written()
    await once(proc, 'disconnect')
    assert.deepEqual(proc.sent, ['last words'])
  })

  it('still disconnects on close after a send that threw', async () => {
    const proc = new FakeChild()
    const link = processLink<unknown, unknown>(proc as unknown as NodeJS.Process)
    assert.throws(() => link.send({ fn: () => {} }), /could not be cloned/)
    link.send('fine')
    link.close()
    await once(proc, 'disconnect')
    assert.deepEqual(proc.sent, ['fine'])
  })

  it('refuses a process without an IPC channel', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process
    assert.throws(
      () => processLink(proc),
      (error: unknown) => error instanceof RpcError && error.code === 'RPC_CLOSED',
    )
  })
})
