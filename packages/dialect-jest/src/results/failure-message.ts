// Jest's failure text for a file, through `jest-message-util` 30.5.2: `formatResultsErrors` for the
// tests' failures and `formatExecError` for an error that kept the file from running. The package
// loads on first use (its imports cost about 21 ms), so a run that fails nothing never loads it.
import { fileURLToPath } from 'node:url'
import type { AssertionResult, SerializableError } from './types.ts'

/**
 * What `jest-message-util` reads of a project: `rootDir` and `testMatch`.
 * @public
 */
export interface StackTraceConfig {
  readonly rootDir: string
  readonly testMatch: readonly string[]
}

/**
 * `jest-message-util`'s `StackTraceOptions`.
 * @public
 */
export interface StackTraceOptions {
  readonly noStackTrace: boolean
  readonly noCodeFrame?: boolean
}

type MessageUtil = typeof import('jest-message-util')

/**
 * The directory of Provino's own packages when this code runs from a workspace checkout
 * (`<repo>/packages/`, from the built umbrella's `packages/provino/dist` as well as a package's
 * `src`); `undefined` from an install. Decoded, as stack frames are: `import.meta.url` is
 * percent-encoded.
 */
const PROVINO_PACKAGES: string | undefined = (() => {
  try {
    const path = fileURLToPath(import.meta.url).replaceAll('\\', '/')
    return /^(.*\/packages\/)[^/]+\/(?:src|dist)\//.exec(path)?.[1]
  } catch {
    return undefined
  }
})()

/**
 * Whether a frame is in one of Provino's own packages: an installed `node_modules/provino` or
 * `node_modules/@provino/<name>` (`jest-message-util` drops only `jest*` frames, so an install's
 * would stay), or `<packages>/<name>/src|dist/` of this checkout (a test, a fixture or a project
 * that sits under `packages/` is the user's). `file://` frames keep their percent-encoding, so both
 * the line and its decoded form are looked at.
 * @internal
 */
export function isProvinoFrame(frame: string, packages: string | undefined): boolean {
  let decoded = frame
  try {
    decoded = decodeURI(frame)
  } catch {
    // A literal `%` that is no escape: the line as it is.
  }
  for (const text of new Set([frame, decoded].map((line) => line.replaceAll('\\', '/')))) {
    if (/\/node_modules\/(?:provino|@provino\/[^/]+)\//.test(text)) return true
    if (packages === undefined) continue
    const at = text.indexOf(packages)
    if (at !== -1 && /^[^/]+\/(?:src|dist)\//.test(text.slice(at + packages.length))) return true
  }
  return false
}

/**
 * `stack` without the frames of Provino's own packages (D104: Jest hides its own internals the
 * same way, in `removeInternalStackEntries`), so the text under a failure is the user's code.
 * @internal
 */
export function hideProvinoFrames(
  stack: string,
  packages: string | undefined = PROVINO_PACKAGES,
): string {
  return stack
    .split('\n')
    .filter((line) => !/^\s+at /.test(line) || !isProvinoFrame(line, packages))
    .join('\n')
}

let loaded: Promise<MessageUtil> | undefined

function messageUtil(): Promise<MessageUtil> {
  loaded ??= import('jest-message-util')
  return loaded
}

/**
 * What `formatResultsErrors` should format for one failure. Jest hands it the thrown `Error`
 * itself (`failureDetailsToErrorOrStack`, jest-message-util 30.5.2 index.ts L640-L658), and formats
 * its `stack` (`formatErrorStackWithSeen` L564-L568); our `failureDetails[i]` is a plain object, so
 * the package formats `failureMessages[i]` instead, which is `flattenErrorStack`'s message, then the
 * stack, when the stack lacks the message. The two differ when the message changed after the stack
 * was taken (dom-testing-library's `waitFor` appends the DOM to a timed-out error's message), so
 * then the stack is formatted, as Jest formats it. A failure that also carries a `cause` or
 * `errors` (more text after the two) is left as it is.
 */
function formattedSource(content: string, detail: unknown): string {
  if (typeof detail !== 'object' || detail === null) return content
  const { message, stack } = detail as { readonly message?: unknown; readonly stack?: unknown }
  if (typeof message !== 'string' || typeof stack !== 'string' || stack === '') return content
  if (message === '' || stack.includes(message)) return content
  return content === message + stack.replace(/^Error:?\s*\n/, '\n') ? stack : content
}

/**
 * The text Jest prints for the failures of one file's tests (`formatResultsErrors`), or `null`
 * when none failed.
 * @public
 */
export async function formatTestFailures(
  assertionResults: readonly AssertionResult[],
  config: StackTraceConfig,
  options: StackTraceOptions,
  testPath: string,
): Promise<string | null> {
  if (assertionResults.every((result) => result.failureMessages.length === 0)) return null
  const util = await messageUtil()
  // The package types `AssertionResult` from `@jest/types`, a structural twin of ours.
  const shown = assertionResults.map((result) => ({
    ...result,
    failureMessages: result.failureMessages.map((message, index) =>
      hideProvinoFrames(formattedSource(message, result.failureDetails[index])),
    ),
  }))
  return util.formatResultsErrors(
    shown as unknown as Parameters<MessageUtil['formatResultsErrors']>[0],
    { rootDir: config.rootDir, testMatch: [...config.testMatch] } as Parameters<
      MessageUtil['formatResultsErrors']
    >[1],
    options,
    testPath,
  )
}

/** A stack line that is a frame. */
const FRAME_LINE = /^\s*at .*:\d+:\d+\)?$/m

/**
 * A file error's stack without Provino's frames. `separateMessageFromStack` (jest-message-util
 * 30.5.1, index.ts L573-L589) takes the message up to the first frame, which in Jest is one of its
 * own: when every frame was Provino's, a frame that `removeInternalStackEntries` always drops
 * (`ANONYMOUS_FN_IGNORE`) stands in for them, so a message over several lines is read whole
 * (`snapshot/resolver-missing-member`).
 */
function withoutProvinoFrames(stack: string): string {
  const hidden = hideProvinoFrames(stack)
  return FRAME_LINE.test(stack) && !FRAME_LINE.test(hidden)
    ? `${hidden}\n    at <anonymous>:1:1`
    : hidden
}

/**
 * The text Jest prints for an error that ended a file (`formatExecError`).
 * @public
 */
export async function formatFileError(
  error: SerializableError,
  config: StackTraceConfig,
  options: StackTraceOptions,
  testPath: string,
): Promise<string> {
  const util = await messageUtil()
  return util.formatExecError(
    typeof error.stack === 'string'
      ? { ...error, stack: withoutProvinoFrames(error.stack) }
      : error,
    { rootDir: config.rootDir, testMatch: [...config.testMatch] } as Parameters<
      MessageUtil['formatExecError']
    >[1],
    options,
    testPath,
  )
}

/**
 * One retried attempt's error as Jest prints it (`formatErrorStack`, what `retryMessages` holds).
 * @public
 */
export async function formatRetryError(
  stack: string,
  config: StackTraceConfig,
  options: StackTraceOptions,
  testPath: string,
): Promise<string> {
  const util = await messageUtil()
  return util.formatErrorStack(
    hideProvinoFrames(stack),
    { rootDir: config.rootDir, testMatch: [...config.testMatch] } as Parameters<
      MessageUtil['formatErrorStack']
    >[1],
    options,
    testPath,
  )
}
