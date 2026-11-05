import type { SerializedError } from '@provino/types'

/** How deep a `cause` chain is followed. */
const MAX_CAUSES = 10

/**
 * Turns anything a reporter threw into a `SerializedError`: name, message, stack, a string `code`
 * and the `cause` chain. Never throws: a field that can't be read is left out. (`@provino/rpc`
 * has the same shape, but a reporter package imports only `@provino/types`.)
 * @internal
 */
export function serializeError(value: unknown): SerializedError {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): SerializedError {
  if (typeof value !== 'object' || value === null) {
    return { name: 'Error', message: describe(value) }
  }
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
    return Reflect.get(value, key)
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
