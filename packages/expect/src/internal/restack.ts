// The stack helpers the engine and `expect.poll` share: an error given the frames of another, made
// where the user called, under a header of its own message.

/**
 * The frames of `captured`'s stack, from the newline that ends its header.
 * @internal
 */
export function framesOf(captured: Error): string {
  const stack = captured.stack ?? ''
  const head = captured.message === '' ? captured.name : `${captured.name}: ${captured.message}`
  return stack.startsWith(head) ? stack.slice(head.length) : stack.slice(stack.indexOf('\n'))
}

/**
 * Gives `error` the frames of `captured` (made where the user called), under `captured`'s name and
 * `error`'s message: the stack an `AssertionError` runner reports for an async assertion, and the
 * one Vitest's `copyStackTrace` gives a poll that timed out (`Error: …`).
 * @internal
 */
export function restack<E extends Error>(error: E, captured: Error): E {
  error.stack = `${captured.name}: ${error.message}${framesOf(captured)}`
  return error
}
