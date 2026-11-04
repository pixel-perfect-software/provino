// One typed RPC channel per worker (Track 1 §Coordinator vs worker, Track 9 §RPC): calls and
// replies over a port both sides share with their other messages. No timeouts (Vitest runs
// birpc with `timeout: -1` too): a call ends when it is answered or when the port exits.
import type { RpcCall, RpcClient, RpcReply, RpcSchema, SerializedError } from '@provino/types'
import { RpcError } from './errors.ts'
import { serializeError } from './internal/serialize.ts'

/**
 * What `createRpc` runs over: a `Transport` on the coordinator side and a `WorkerPort` on the
 * worker side both fit as they are. `Out` is what this side sends (its calls and its replies);
 * other messages on the port pass by untouched.
 * @public
 */
export interface RpcPort<Out> {
  send(message: Out): void
  onMessage(listener: (message: { readonly t: string }) => void): () => void
  /** Called once when the port closes; `cause` becomes every pending call's rejection cause. */
  onExit(listener: (cause: unknown) => void): () => void
}

/**
 * The implementations of `Methods` that this side serves. A handler may return its result or a
 * promise of it.
 * @public
 */
export type RpcHandlers<Methods> = {
  readonly [K in keyof Methods]: Methods[K] extends (...args: infer A) => infer R
    ? (...args: A) => Awaited<R> | Promise<Awaited<R>>
    : never
}

/**
 * Options for `createRpc`.
 * @public
 */
export interface RpcOptions {
  /** Serializes a handler's error for its reply. The default keeps name, message, stack, `code` and causes. */
  readonly serializeError?: (error: unknown) => SerializedError
}

interface Pending {
  readonly method: string
  resolve(value: unknown): void
  reject(error: RpcError): void
}

/**
 * Serves `handlers` (this side's `Local` methods) on `port` and returns a client for the other
 * side's `Remote` methods. Both method sets must be clone-safe (`RpcSchema`): a method taking
 * `() => void` doesn't compile.
 *
 * Arguments and results must also survive the link: a fork's advanced serialization rejects a
 * `SharedArrayBuffer` (threads and inline accept it), and a class instance arrives as a plain
 * object everywhere, a `Buffer` as a `Uint8Array` over threads and inline.
 *
 * A handler's error comes back as `RpcError('RPC_REMOTE_ERROR')` with the error on `.remote`. When
 * the port exits, every pending call, and every call made after, rejects with
 * `RpcError('RPC_CLOSED')` whose `cause` is the port's exit value (the `WorkerExit` on the
 * coordinator side).
 * @public
 */
export function createRpc<Local extends RpcSchema<Local>, Remote extends RpcSchema<Remote>>(
  port: RpcPort<RpcCall<Remote> | RpcReply<Local>>,
  handlers: RpcHandlers<Local>,
  options: RpcOptions = {},
): RpcClient<Remote> {
  const serialize = options.serializeError ?? serializeError
  const pending = new Map<number, Pending>()
  let nextId = 0
  let closed: { readonly cause: unknown } | undefined

  // The port's two directions are typed per side; inside, a call is a method name and arguments.
  const send = port.send.bind(port) as (message: WireMessage) => void

  const offMessage = port.onMessage((message) => {
    if (message.t === 'call') void answer(message as WireCall)
    else if (message.t === 'reply') settle(message as WireReply)
  })
  port.onExit((cause) => {
    if (closed !== undefined) return
    closed = { cause }
    offMessage()
    for (const call of pending.values()) {
      call.reject(
        new RpcError('RPC_CLOSED', `The link closed before \`${call.method}\` was answered`, {
          cause,
        }),
      )
    }
    pending.clear()
  })

  async function answer(call: WireCall): Promise<void> {
    let reply: WireReply
    try {
      const value = await invoke(handlers, call.method, call.args)
      reply = { t: 'reply', id: call.id, ok: true, value }
    } catch (error) {
      reply = { t: 'reply', id: call.id, ok: false, error: serializeOr(error) }
    }
    if (closed !== undefined) return
    try {
      send(reply)
    } catch (error) {
      // The result (or the serialized error) didn't clone. Tell the caller rather than leave it
      // waiting, with an error that is plain strings and always sends.
      const what = reply.ok ? 'result' : 'error'
      const message = `\`${call.method}\`'s ${what} can't cross the link: ${messageOf(error)}`
      try {
        send({ t: 'reply', id: call.id, ok: false, error: unclonable(message) })
      } catch {
        // Only a closing link fails a send of plain strings; its exit rejects the caller.
      }
    }
  }

  /** The configured serializer, or a fixed error if it throws: a reply must always be built. */
  function serializeOr(error: unknown): SerializedError {
    try {
      return serialize(error)
    } catch (failure) {
      return unclonable(`The error couldn't be serialized: ${messageOf(failure)}`)
    }
  }

  function settle(reply: WireReply): void {
    const call = pending.get(reply.id)
    if (call === undefined) return
    pending.delete(reply.id)
    if (reply.ok) call.resolve(reply.value)
    else call.reject(new RpcError('RPC_REMOTE_ERROR', reply.error.message, { remote: reply.error }))
  }

  function call(method: string, args: readonly unknown[]): Promise<unknown> {
    if (closed !== undefined) {
      return Promise.reject(
        new RpcError('RPC_CLOSED', `The link is closed; \`${method}\` wasn't sent`, {
          cause: closed.cause,
        }),
      )
    }
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject })
      try {
        send({ t: 'call', id, method, args })
      } catch (error) {
        pending.delete(id)
        reject(
          new RpcError(
            'RPC_UNCLONABLE',
            `\`${method}\`'s arguments can't cross the link: ${messageOf(error)}`,
            { cause: error },
          ),
        )
      }
    })
  }

  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      // Not a thenable, so `await client` and promise resolution leave it alone; and no stub for a
      // name that inspection reads (`toJSON`, `toString`, a matcher's `asymmetricMatch`), so
      // printing or serializing the client never sends a call.
      if (typeof key !== 'string' || NOT_METHODS.has(key) || key in Object.prototype)
        return undefined
      let method = methods.get(key)
      if (method === undefined) {
        method = (...args) => call(key, args)
        methods.set(key, method)
      }
      return method
    },
  }) as RpcClient<Remote>
}

type WireCall = {
  readonly t: 'call'
  readonly id: number
  readonly method: string
  readonly args: readonly unknown[]
}
type WireReply =
  | { readonly t: 'reply'; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly t: 'reply'
      readonly id: number
      readonly ok: false
      readonly error: SerializedError
    }
type WireMessage = WireCall | WireReply

/** Names read by promise resolution, `JSON.stringify`, pretty-format and the like, never methods. */
const NOT_METHODS: ReadonlySet<string> = new Set([
  'then',
  'toJSON',
  'asymmetricMatch',
  '$$typeof',
  'nodeType',
  '@@__IMMUTABLE_ITERABLE__@@',
  '@@__IMMUTABLE_RECORD__@@',
])

/** A plain-strings error for a reply that couldn't be built or sent. */
function unclonable(message: string): SerializedError {
  return { name: 'RpcError', message, code: 'RPC_UNCLONABLE' }
}

/** Calls `handlers[method]`, rejecting names that aren't served (including `Object.prototype`'s). */
async function invoke(
  handlers: object,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  const handler: unknown = (handlers as Record<string, unknown>)[method]
  if (
    typeof handler !== 'function' ||
    handler === (Object.prototype as Record<string, unknown>)[method]
  ) {
    throw new RpcError('RPC_UNKNOWN_METHOD', `No RPC method \`${method}\` is served here`)
  }
  return await Reflect.apply(handler, handlers, args)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
