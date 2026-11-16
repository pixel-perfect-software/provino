// `core.shapeTestError` for Jest: jest-circus's `formatNodeAssertErrors` (30.5.2). A test that fails
// with a `node:assert` AssertionError reads `assert.equal(received, expected)`, `Expected value to be
// equal to:` and a diff, not Node's `AssertionError [ERR_ASSERTION]: ...`. The error is replaced by
// `{ message }`, as circus replaces it at `test_done`: its text already holds the stack's frames.
import type { ShapeTestError } from '@provino/types'
import formatNodeAssertErrors from './vendor/jest-circus/formatNodeAssertErrors.ts'

/**
 * Jest's text for a failed `node:assert` call, as the error's replacement; any other error as it
 * is. A diff prints in full under `expand` (`--expand`), as `state.expand` does in circus.
 * @public
 */
export const shapeTestError: ShapeTestError = (error, { expand }) => {
  // Core hands over what a body or hook threw, which circus keeps as `[error, asyncError]`; a value
  // with no stack is swapped there for `asyncError`, an ordinary Error that is no assertion error,
  // so it is left as it was thrown (`cli/node-assert`). The pair needs no `asyncError` of ours.
  if (!(error as { readonly stack?: unknown } | null | undefined)?.stack) return error
  const entry = [error, undefined]
  const shaped = formatNodeAssertErrors(entry, expand)
  if (shaped === entry) return error
  const { message } = shaped as { message: string }
  // The result reads as an error to the serializer (`message` and `stack`) and has the one
  // enumerable key Jest's `failureDetails[i]` has: `stack` is the message too, and hidden.
  const replaced = { message }
  Object.defineProperty(replaced, 'stack', { value: message, enumerable: false })
  // `name` stays what the assertion error had (`AssertionError`) for what reads it off the
  // serialized error (a JUnit `type`); hidden, so `--json` still holds `{ message }`.
  const { name } = error as { name?: unknown }
  if (typeof name === 'string') Object.defineProperty(replaced, 'name', { value: name })
  return replaced
}
