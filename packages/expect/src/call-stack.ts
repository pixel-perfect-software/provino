// Where a matcher was called, for an inline snapshot it may have to write: the one rule for the
// snapshot matchers and for a dialect's view of the snapshot state (a custom matcher that calls
// the runner's own snapshot matcher). The engine names its frames in `expect.ts`: every matcher is
// called from `throwingMatcher`, and a custom one inside `__EXTERNAL_MATCHER_TRAP__` (a function
// name must be written as one, so the names are here as text and there as code;
// `call-stack.test.ts` holds the two together through a real `createExpect`).

/**
 * The engine's frames around a matcher: `throwingMatcher` calls every matcher
 * (`makeThrowingMatcher` in `expect.ts`), and a custom one runs inside
 * `__EXTERNAL_MATCHER_TRAP__`, Jest's name, which jest-snapshot cuts its stack at.
 */
const ENGINE_FRAME = /\b(?:throwingMatcher|__EXTERNAL_MATCHER_TRAP__)\b/

/** Enough frames to reach the user's call through two nested custom matchers and the state. */
const CALL_STACK_LIMIT = 50

/**
 * The stack of a matcher's call, its first frame the user's call, taken when the thunk runs (the
 * state calls it only when it writes an inline snapshot, inside the same `match` call). Under
 * `.resolves`/`.rejects` it is the error the engine made at the call (Jest's `context.error`).
 * Otherwise it is Jest's rule (State.ts `_addSnapshot`, utils.ts
 * `removeLinesBeforeExternalMatcherTrap`): the lines after the innermost matcher call, past the
 * engine's frames, which Jest's `getTopFrame` passes over in `node_modules` and which, run from
 * source, are outside it here. Jest registers its own snapshot matchers with `expect.extend`, so
 * they run inside a trap as a custom one does; Provino's are built-ins with no trap, so for them
 * the innermost call is the engine's `throwingMatcher`. Either way a matcher called through
 * `expect` inside a custom matcher writes into that matcher's body
 * (`ecosystem/custom-snapshot-inline-nested`).
 * @public
 */
export function matcherCallStack(error: Error | undefined): () => string {
  const stack = (): string => {
    if (error?.stack !== undefined) return error.stack
    const holder: { stack?: string } = {}
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = Math.max(limit, CALL_STACK_LIMIT)
    try {
      Error.captureStackTrace(holder, stack)
    } finally {
      Error.stackTraceLimit = limit
    }
    const lines = (holder.stack ?? '').split('\n')
    const cut = lines.findIndex((line) => ENGINE_FRAME.test(line))
    if (cut === -1) return lines.join('\n')
    let at = cut + 1
    while (at < lines.length && ENGINE_FRAME.test(lines[at] ?? '')) at++
    return lines.slice(at).join('\n')
  }
  return stack
}
