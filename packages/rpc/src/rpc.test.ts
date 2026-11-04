// `createRpc` over real `MessageChannel`s (T1.9's round trip) and over a hand-driven port, for the
// exit paths: pending calls reject with the port's exit cause.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import type { MessageLink, RpcCall, RpcReply, SerializedError, WorkerExit } from '@provino/types'
import { RpcError } from './errors.ts'
import { messagePortLink } from './links.ts'
import { createRpc, type RpcPort } from './rpc.ts'

interface Left {
  add(a: number, b: number): number
  echo(value: { readonly when: Date; readonly tags: Set<string>; readonly big: bigint }): Promise<{
    readonly when: Date
    readonly tags: Set<string>
    readonly big: bigint
  }>
  fail(message: string): Promise<void>
  never(): Promise<void>
}
interface Right {
  greet(name: string): string
}

type LeftSends = RpcCall<Right> | RpcReply<Left>
type RightSends = RpcCall<Left> | RpcReply<Right>

function channel(): { left: MessageLink<LeftSends, never>; right: MessageLink<RightSends, never> } {
  const { port1, port2 } = new MessageChannel()
  return { left: messagePortLink(port1), right: messagePortLink(port2) }
}

const leftHandlers = {
  add: (a: number, b: number) => a + b,
  echo: async (value: Parameters<Left['echo']>[0]) => value,
  fail: async (message: string): Promise<void> => {
    throw Object.assign(new TypeError(message), { code: 'E_FAIL', cause: new Error('root') })
  },
  never: () => new Promise<void>(() => {}),
}

/** A port the test drives by hand: it records sends and fires exit on demand. */
function manualPort(): {
  port: RpcPort<never>
  sent: unknown[]
  receive(message: { readonly t: string }): void
  exit(cause: unknown): void
} {
  const sent: unknown[] = []
  let onMessage: ((message: { readonly t: string }) => void) | undefined
  let onExit: ((cause: unknown) => void) | undefined
  return {
    port: {
      send: (message) => void sent.push(message),
      onMessage(listener) {
        onMessage = listener
        return () => {
          onMessage = undefined
        }
      },
      onExit(listener) {
        onExit = listener
        return () => {}
      },
    },
    sent,
    receive: (message) => onMessage?.(message),
    exit: (cause) => onExit?.(cause),
  }
}

describe('createRpc over a MessageChannel', () => {
  it('round-trips calls both ways, keeping clone-safe values', async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    const toRight = createRpc<Left, Right>(left, leftHandlers)
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => `hi ${name}` })

    assert.equal(await toLeft.add(2, 3), 5)
    assert.equal(await toRight.greet('ada'), 'hi ada')
    const value = { when: new Date(0), tags: new Set(['a', 'b']), big: 10n ** 20n }
    assert.deepEqual(await toLeft.echo(value), value)
  })

  it('answers many concurrent calls by id', async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Left, Right>(left, leftHandlers)
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    const sums = await Promise.all(Array.from({ length: 200 }, (_, i) => toLeft.add(i, i)))
    assert.deepEqual(
      sums,
      Array.from({ length: 200 }, (_, i) => 2 * i),
    )
  })

  it("rejects with the remote error's name, message, code and cause", async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Left, Right>(left, leftHandlers)
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    const error = await toLeft.fail('nope').then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    )
    assert.ok(error instanceof RpcError)
    assert.equal(error.code, 'RPC_REMOTE_ERROR')
    assert.equal(error.message, 'nope')
    assert.equal(error.remote?.name, 'TypeError')
    assert.equal(error.remote?.code, 'E_FAIL')
    assert.equal(error.remote?.cause?.message, 'root')
    assert.match(error.remote?.stack ?? '', /TypeError: nope/)
  })

  it('answers a method that is not served', async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Left, Right>(left, leftHandlers)
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    const toLeftUntyped = toLeft as unknown as Record<string, () => Promise<unknown>>
    await assert.rejects((toLeftUntyped.missing as () => Promise<unknown>)(), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, 'RPC_REMOTE_ERROR')
      assert.equal(error.remote?.code, 'RPC_UNKNOWN_METHOD')
      return true
    })
  })

  it('refuses a call naming an Object.prototype method, from any client', async () => {
    const manual = manualPort()
    createRpc<Left, Right>(manual.port as RpcPort<RpcCall<Right> | RpcReply<Left>>, leftHandlers)
    for (const [id, method] of [
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
    ].entries()) {
      manual.receive({ t: 'call', id, method, args: [] } as { readonly t: string })
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      manual.sent.map((reply) => (reply as { error?: { code?: string } }).error?.code),
      ['RPC_UNKNOWN_METHOD', 'RPC_UNKNOWN_METHOD', 'RPC_UNKNOWN_METHOD', 'RPC_UNKNOWN_METHOD'],
    )
  })

  it("rejects a call whose arguments can't be cloned, without sending it", async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Left, Right>(left, leftHandlers)
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    const sneaky = { when: new Date(0), tags: new Set<string>(), big: 1n, fn: () => {} }
    await assert.rejects(toLeft.echo(sneaky), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, 'RPC_UNCLONABLE')
      assert.equal((error.cause as Error).name, 'DataCloneError')
      return true
    })
    assert.equal(await toLeft.add(1, 1), 2)
  })

  it("answers with an error when a result can't be cloned", async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Right, Left>(right, {
      greet: () => (() => 'not data') as unknown as string,
    })
    const toRight = createRpc<Left, Right>(left, leftHandlers)
    await assert.rejects(toRight.greet('x'), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.remote?.code, 'RPC_UNCLONABLE')
      assert.match(error.message, /`greet`'s result can't cross the link/)
      return true
    })
  })

  it('rejects pending calls with the link-closed cause when the other end closes', async () => {
    const { left, right } = channel()
    createRpc<Left, Right>(left, leftHandlers)
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    const pending = toLeft.never()
    await toLeft.add(0, 0) // the `never` call has reached the other side
    left.close()
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, 'RPC_CLOSED')
      assert.deepEqual(error.cause, { type: 'closed' })
      return true
    })
  })
})

describe('createRpc when a reply can’t be built or sent', () => {
  it('answers with a fixed error when the serializer throws, so the caller isn’t left waiting', async (t) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    t.after(() => process.off('unhandledRejection', onUnhandled))
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Left, Right>(left, leftHandlers, {
      serializeError: () => {
        throw new Error('serializer broke')
      },
    })
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    await assert.rejects(toLeft.fail('x'), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, 'RPC_REMOTE_ERROR')
      assert.equal(error.remote?.code, 'RPC_UNCLONABLE')
      return true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  })

  it('answers with a fixed error when the serialized error itself can’t be sent', async (t) => {
    const { left, right } = channel()
    t.after(() => left.close())
    createRpc<Left, Right>(left, leftHandlers, {
      serializeError: (error) => ({
        name: 'Error',
        message: String(error),
        cause: { name: 'X', message: 'x', extra: () => 1 } as unknown as SerializedError,
      }),
    })
    const toLeft = createRpc<Right, Left>(right, { greet: (name) => name })
    await assert.rejects(toLeft.fail('x'), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.remote?.code, 'RPC_UNCLONABLE')
      return true
    })
  })
})

describe('createRpc when the port exits', () => {
  it('rejects every pending call with the exit cause', async () => {
    const manual = manualPort()
    const client = createRpc<Right, Left>(manual.port as RpcPort<RpcCall<Left> | RpcReply<Right>>, {
      greet: (name) => name,
    })
    const calls = [client.add(1, 2), client.never(), client.fail('x')]
    assert.equal(manual.sent.length, 3)
    const exit: WorkerExit = { type: 'exit', code: 7 }
    manual.exit(exit)
    for (const call of calls) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.code, 'RPC_CLOSED')
        assert.equal(error.cause, exit)
        return true
      })
    }
  })

  it('rejects calls made after the exit at once, without sending them', async () => {
    const manual = manualPort()
    const client = createRpc<Right, Left>(manual.port as RpcPort<RpcCall<Left> | RpcReply<Right>>, {
      greet: (name) => name,
    })
    const exit: WorkerExit = { type: 'signal', signal: 'SIGSEGV', likelyOom: false }
    manual.exit(exit)
    await assert.rejects(client.add(1, 1), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, 'RPC_CLOSED')
      assert.equal(error.cause, exit)
      return true
    })
    assert.equal(manual.sent.length, 0)
  })

  it("doesn't answer calls that arrive after the exit, and ignores stray replies", async () => {
    const manual = manualPort()
    const client = createRpc<Right, Left>(manual.port as RpcPort<RpcCall<Left> | RpcReply<Right>>, {
      greet: (name) => name,
    })
    manual.receive({ t: 'reply', id: 99, ok: true, value: 1 } as { readonly t: string })
    manual.receive({ t: 'pack' })
    const pending = client.add(1, 1)
    manual.receive({ t: 'reply', id: 0, ok: true, value: 2 } as { readonly t: string })
    assert.equal(await pending, 2)
    manual.exit({ type: 'exit', code: 0 })
    manual.receive({ t: 'call', id: 0, method: 'greet', args: ['x'] } as { readonly t: string })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manual.sent.length, 1)
  })

  it('has no stubs for Object.prototype or introspection names, so serializing it sends nothing', () => {
    const manual = manualPort()
    const client = createRpc<Right, Left>(manual.port as RpcPort<RpcCall<Left> | RpcReply<Right>>, {
      greet: (name) => name,
    })
    const untyped = client as unknown as Record<string, unknown>
    for (const name of [
      'toJSON',
      'toString',
      'valueOf',
      'constructor',
      'hasOwnProperty',
      'asymmetricMatch',
      '$$typeof',
      'nodeType',
    ]) {
      assert.equal(untyped[name], undefined, name)
    }
    assert.equal(JSON.stringify({ coordinator: client }), '{"coordinator":{}}')
    assert.equal(typeof client.add, 'function')
    assert.equal(manual.sent.length, 0)
  })

  it('is not a thenable, so awaiting it yields the client itself', async () => {
    const manual = manualPort()
    const client = createRpc<Right, Left>(manual.port as RpcPort<RpcCall<Left> | RpcReply<Right>>, {
      greet: (name) => name,
    })
    assert.equal(await Promise.resolve(client), client)
    assert.equal(client.add, client.add)
  })
})
