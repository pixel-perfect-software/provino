// The default error serializer for RPC replies and the worker's own unhandled errors. Those are the
// coordinator's and worker's errors (a snapshot write that failed, a runner that threw), so this
// keeps what crosses well: name, message, stack, a string `code` and the `cause` chain. Core's
// `serializeError` is the full one (aggregates, a budget against hostile getters); the worker can
// pass it through `RpcOptions.serializeError` and `StartWorkerOptions.serializeError`.
import type { SerializedError } from '@provino/types'

/** How deep a `cause` chain is followed. */
const MAX_CAUSES = 10

/**
 * Turns anything thrown into a clone-safe `SerializedError`. Never throws: a field that can't be
 * read is left out.
 * @public
 */
export function serializeError(value: unknown): SerializedError {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): SerializedError {
  if (typeof value !== 'object' || value === null)
    return { name: 'Error', message: describe(value) }
  const name = read(value, 'name')
  const message = read(value, 'message')
  const stack = read(value, 'stack')
  const code = read(value, 'code')
  const cause = depth < MAX_CAUSES ? read(value, 'cause') : undefined
  return {
    name: typeof name === 'string' ? name : 'Error',
    message: typeof message === 'string' ? message : describe(message),
    ...(typeof stack === 'string' ? { stack } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(cause === undefined ? {} : { cause: serialize(cause, depth + 1) }),
  }
}

function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function describe(value: unknown): string {
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
