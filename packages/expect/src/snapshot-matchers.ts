// The snapshot matchers (T7.10): `toMatchSnapshot`, `toMatchInlineSnapshot`,
// `toThrowErrorMatchingSnapshot`, `toThrowErrorMatchingInlineSnapshot` and `toMatchFileSnapshot`.
// They are Jest 30.5.2's `jest-snapshot` matchers (`index.ts`: `_toMatchSnapshot`,
// `_toThrowErrorMatchingSnapshot`), over `@provino/snapshot/runtime`'s state: the state holds the
// file's snapshots and the dialect's words, so this module names neither runner. A dialect puts
// the set in its table (`snapshotMatchers()`); a matcher finds the file's state in the matcher
// state, where the worker put it (Jest's `setState({ snapshotState })`).
//
// One difference from Jest, until T7.8: Jest calls `this.dontThrow()` first, so a mismatch is
// added to the test's `suppressedErrors` and the test goes on to its other snapshots (and fails
// when it ends). Nothing reads `suppressedErrors` at the end of a test yet, so a held-back
// mismatch would pass; these matchers throw at the call instead. The test fails either way, but
// its later snapshots aren't checked, so they count as obsolete (the lifecycle marks a failed
// test's snapshots as checked, which covers the stored ones). T7.8 turns `dontThrow` on here.
import { dirname, resolve } from 'node:path'
import {
  deepMerge,
  type MatchResult,
  SnapshotError,
  SnapshotState,
} from '@provino/snapshot/runtime'
import type {
  Matcher,
  MatcherResult,
  MatcherSet,
  SnapshotMessageInfo,
  SnapshotPlugin,
} from '@provino/types'
import type { MatcherContext } from './context.ts'

/** What one snapshot call carries. */
interface Call {
  readonly context: MatcherContext
  readonly state: SnapshotState
  readonly matcherName: string
  readonly isInline: boolean
  readonly hint: string | undefined
  readonly inlineSnapshot: string | undefined
  readonly properties: object | undefined
  readonly received: unknown
}

/** A result with what Jest adds: the matcher's name, and where the snapshot is stored. */
type SnapshotResult = MatcherResult & { readonly name: string; readonly snapshotPath?: string }

const INLINE_NOT_WRITTEN =
  'An inline snapshot would have to be written into the test file, and nothing writes inline snapshots yet (T7.11). ' +
  'Run with --ci to treat a missing inline snapshot as a failure, or write the snapshot by hand.'

const INDENTATION_REGEX = /^([^\S\n]*)\S/m

/**
 * Takes off the indentation an inline snapshot was written with, when every line has it
 * (index.ts L77-L110): the template literal in the source is indented to the call.
 */
function stripAddedIndentation(inlineSnapshot: string): string {
  const match = inlineSnapshot.match(INDENTATION_REGEX)
  const indentation = match?.[1]
  if (!indentation) return inlineSnapshot
  const lines = inlineSnapshot.split('\n')
  if (lines.length <= 2) return inlineSnapshot
  if (lines[0]?.trim() !== '' || lines.at(-1)?.trim() !== '') return inlineSnapshot
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i] ?? ''
    if (line !== '') {
      if (line.indexOf(indentation) !== 0) return inlineSnapshot
      lines[i] = line.slice(indentation.length)
    }
  }
  lines[lines.length - 1] = ''
  return lines.join('\n')
}

/** `jest-util`'s `isError`. */
function isError(value: unknown): value is Error {
  switch (Object.prototype.toString.call(value)) {
    case '[object Error]':
    case '[object Exception]':
    case '[object DOMException]':
      return true
    default:
      return value instanceof Error
  }
}

const isSnapshotState = (value: unknown): value is SnapshotState =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'match') === 'function' &&
  typeof Reflect.get(value, 'testName') === 'function'

/** The file's snapshot state: Jest's "Snapshot state must be initialized". */
function stateOf(context: MatcherContext, matcherName: string): SnapshotState {
  const { snapshotState } = context
  if (!isSnapshotState(snapshotState)) {
    throw new SnapshotError(
      'SNAPSHOT_NOT_INITIALIZED',
      `expect(received).${matcherName}()\n\nSnapshot state must be initialized: the matcher ran outside a test file's run`,
    )
  }
  return snapshotState
}

function notAllowedWithNot(matcherName: string): Error {
  return new Error(
    `expect(received).not.${matcherName}()\n\nSnapshot matchers cannot be used with not`,
  )
}

/** The test's title path for the snapshot's name. */
function titlePathOf(context: MatcherContext): readonly string[] {
  if (context.currentTestPath !== undefined) return context.currentTestPath
  return context.currentTestName === undefined || context.currentTestName === ''
    ? []
    : [context.currentTestName]
}

function infoOf(
  call: Call,
  result: Pick<MatchResult, 'key' | 'count' | 'expected' | 'actual'>,
  titlePath: readonly string[],
): SnapshotMessageInfo {
  const { state, context } = call
  return {
    matcherName: call.matcherName,
    isInline: call.isInline,
    hint: call.hint ?? '',
    currentTestName: state.testName(titlePath, undefined),
    key: result.key,
    count: result.count,
    expand: state.expand || context.expand === true,
    expected: result.expected,
    actual: result.actual,
    received: call.received,
    ...(call.properties === undefined ? {} : { properties: call.properties }),
  }
}

/** Jest's `_toMatchSnapshot` (index.ts L222-L367). */
function match(call: Call): SnapshotResult {
  const { context, state, matcherName, isInline, hint, inlineSnapshot, properties } = call
  let { received } = call
  if (context.isNot) throw notAllowedWithNot(matcherName)

  const titlePath = titlePathOf(context)
  const testName = state.testName(titlePath, hint)
  const testId = context.currentTestId
  const testFailing = context.testFailing === true
  const base = { name: matcherName, ...(isInline ? {} : { snapshotPath: state.snapshotPath }) }

  if (typeof properties === 'object') {
    if (typeof received !== 'object' || received === null) {
      throw new Error(
        `expect(received).${matcherName}(properties)\n\nreceived value must be an object when the matcher has properties\n\nReceived: ${String(received)}`,
      )
    }
    const { iterableEquality, subsetEquality } = context.utils as {
      iterableEquality?: never
      subsetEquality?: never
    }
    const propertyPass = context.equals(received, properties, [
      ...(iterableEquality ? [iterableEquality] : []),
      ...(subsetEquality ? [subsetEquality] : []),
    ])
    if (propertyPass) {
      received = deepMerge(received, properties)
    } else {
      const key = state.fail(testName, testId)
      const count = Number(/(\d+)$/.exec(key)?.[1] ?? 1)
      const info = infoOf(
        { ...call, received },
        { key, count, expected: undefined, actual: '' },
        titlePath,
      )
      return { ...base, pass: false, message: () => state.messages.propertiesMismatch(info) }
    }
  }

  const result = state.match({
    testName,
    ...(testId === undefined ? {} : { testId }),
    received,
    ...(inlineSnapshot === undefined ? {} : { inlineSnapshot }),
    isInline,
    testFailing,
  })
  if (result.pass) return { message: () => '', pass: true, name: matcherName }

  const info = infoOf({ ...call, received }, result, titlePath)
  if (result.inlineNotWritten) {
    return { ...base, pass: false, message: () => `${matcherName}: ${INLINE_NOT_WRITTEN}` }
  }
  // Passing the actual and expected strings so that a reporter can show its own diff.
  return {
    ...base,
    actual: result.actual,
    expected: result.expected,
    pass: false,
    message:
      result.expected === undefined
        ? () => state.messages.notWritten(info)
        : () => state.messages.mismatch(info),
  }
}

function toMatchSnapshot(
  this: MatcherContext,
  received: unknown,
  ...args: unknown[]
): SnapshotResult {
  const matcherName = 'toMatchSnapshot'
  const state = stateOf(this, matcherName)
  const [propertiesOrHint, hintArgument] = args
  let properties: object | undefined
  let hint: string | undefined
  if (args.length === 1 && typeof propertiesOrHint === 'string') {
    hint = propertiesOrHint
  } else if (args.length >= 1) {
    if (typeof propertiesOrHint !== 'object' || propertiesOrHint === null) {
      throw new Error(
        `expect(received).${matcherName}(properties${args.length === 2 ? ', hint' : ''})\n\nExpected properties must be an object\n\nExpected properties: ${String(propertiesOrHint)}${
          args.length === 2 && propertiesOrHint == null
            ? "\n\nTo provide a hint without properties: toMatchSnapshot('hint')"
            : ''
        }`,
      )
    }
    properties = propertiesOrHint
    hint = typeof hintArgument === 'string' ? hintArgument : undefined
  }
  return match({
    context: this,
    state,
    matcherName,
    isInline: false,
    hint,
    inlineSnapshot: undefined,
    properties,
    received,
  })
}

function toMatchInlineSnapshot(
  this: MatcherContext,
  received: unknown,
  ...args: unknown[]
): SnapshotResult {
  const matcherName = 'toMatchInlineSnapshot'
  const state = stateOf(this, matcherName)
  const [propertiesOrSnapshot, snapshotArgument] = args
  let properties: object | undefined
  let inlineSnapshot: unknown
  if (args.length === 1 && typeof propertiesOrSnapshot === 'string') {
    inlineSnapshot = propertiesOrSnapshot
  } else if (args.length >= 1) {
    if (typeof propertiesOrSnapshot !== 'object' || propertiesOrSnapshot === null) {
      throw new Error(
        `expect(received).${matcherName}(properties)\n\nExpected properties must be an object\n\nExpected properties: ${String(propertiesOrSnapshot)}`,
      )
    }
    if (args.length === 2 && typeof snapshotArgument !== 'string') {
      throw new Error(
        `expect(received).${matcherName}(properties, snapshot)\n\nInline snapshot must be a string\n\nInline snapshot: ${String(snapshotArgument)}`,
      )
    }
    properties = propertiesOrSnapshot
    inlineSnapshot = snapshotArgument
  }
  return match({
    context: this,
    state,
    matcherName,
    isInline: true,
    hint: undefined,
    inlineSnapshot:
      typeof inlineSnapshot === 'string' ? stripAddedIndentation(inlineSnapshot) : undefined,
    properties,
    received,
  })
}

/**
 * The text of an error as `toThrowErrorMatchingSnapshot` stores it in Jest: the message, then
 * `\nCause: ` and the message of each cause down the chain (index.ts L552-L564). As in Jest, the
 * message is kept as it is (a thrown object without one stores `undefined`) and a thrown primitive
 * fails the test with the `in` operator's own TypeError.
 */
function messageWithCauses(thrown: unknown): unknown {
  let error = thrown as { message?: unknown; cause?: unknown }
  let message: unknown = error.message
  while ('cause' in error) {
    const cause: unknown = error.cause
    if (isError(cause)) {
      error = cause
      message = `${String(message)}\nCause: ${cause.message}`
    } else {
      if (typeof cause === 'string') message = `${String(message)}\nCause: ${cause}`
      break
    }
  }
  return message
}

/** Jest's `_toThrowErrorMatchingSnapshot` (index.ts L494-L567). */
function matchThrown(
  context: MatcherContext,
  received: unknown,
  options: {
    readonly matcherName: string
    readonly isInline: boolean
    readonly hint: string | undefined
    readonly inlineSnapshot: string | undefined
    readonly fromPromise: boolean
  },
): SnapshotResult {
  const { matcherName, isInline, hint, inlineSnapshot, fromPromise } = options
  const state = stateOf(context, matcherName)
  if (!fromPromise && typeof received !== 'function') {
    throw new Error(
      `expect(received).${matcherName}()\n\nreceived value must be a function\n\nReceived: ${String(received)}`,
    )
  }
  if (context.isNot) throw notAllowedWithNot(matcherName)

  let error: unknown
  if (fromPromise) {
    error = received
  } else {
    try {
      ;(received as () => unknown)()
    } catch (receivedError) {
      error = receivedError
    }
  }
  if (error === undefined) {
    throw new Error(`expect(received).${matcherName}()\n\nReceived function did not throw`)
  }
  // Jest stores the message and its causes; Vitest stores the error itself, which pretty-format
  // prints as `[Error: message]`.
  const body = state.throwErrorBody === 'message' ? messageWithCauses(error) : error
  return match({
    context,
    state,
    matcherName,
    isInline,
    hint,
    inlineSnapshot,
    properties: undefined,
    received: body,
  })
}

function toThrowErrorMatchingSnapshot(
  this: MatcherContext,
  received: unknown,
  hint?: unknown,
  fromPromise?: unknown,
): SnapshotResult {
  return matchThrown(this, received, {
    matcherName: 'toThrowErrorMatchingSnapshot',
    isInline: false,
    hint: typeof hint === 'string' ? hint : undefined,
    inlineSnapshot: undefined,
    fromPromise: fromPromise === true,
  })
}

function toThrowErrorMatchingInlineSnapshot(
  this: MatcherContext,
  received: unknown,
  inlineSnapshot?: unknown,
  fromPromise?: unknown,
): SnapshotResult {
  const matcherName = 'toThrowErrorMatchingInlineSnapshot'
  if (inlineSnapshot !== undefined && typeof inlineSnapshot !== 'string') {
    throw new Error(
      `expect(received).${matcherName}(snapshot)\n\nInline snapshot must be a string\n\nInline snapshot: ${String(inlineSnapshot)}`,
    )
  }
  return matchThrown(this, received, {
    matcherName,
    isInline: true,
    hint: undefined,
    inlineSnapshot:
      inlineSnapshot === undefined ? undefined : stripAddedIndentation(inlineSnapshot),
    fromPromise: fromPromise === true,
  })
}

/** Vitest's `toMatchFileSnapshot(file, hint?)`: the value is compared with a file's contents. */
async function toMatchFileSnapshot(
  this: MatcherContext,
  received: unknown,
  file?: unknown,
  hint?: unknown,
): Promise<SnapshotResult> {
  const matcherName = 'toMatchFileSnapshot'
  const state = stateOf(this, matcherName)
  if (this.isNot) throw notAllowedWithNot(matcherName)
  if (typeof file !== 'string' || file === '') {
    throw new Error(
      `expect(received).${matcherName}(file)\n\nThe file must be a path, relative to the test file or absolute`,
    )
  }
  const path = resolve(dirname(state.testPath), file)
  if (path === state.snapshotPath) {
    throw new Error(`File snapshot cannot use the same path as the test snapshot file: ${path}`)
  }
  const titlePath = titlePathOf(this)
  const result = state.matchRaw({
    testName: state.testName(titlePath, typeof hint === 'string' ? hint : undefined),
    ...(this.currentTestId === undefined ? {} : { testId: this.currentTestId }),
    received,
    file: path,
    existing: SnapshotState.readRaw(path),
  })
  if (result.pass) return { message: () => '', pass: true, name: matcherName }
  const info = infoOf(
    {
      context: this,
      state,
      matcherName,
      isInline: false,
      hint: typeof hint === 'string' ? hint : undefined,
      inlineSnapshot: undefined,
      properties: undefined,
      received,
    },
    result,
    titlePath,
  )
  return {
    name: matcherName,
    pass: false,
    actual: result.actual,
    expected: result.expected,
    message:
      result.expected === undefined
        ? () => state.messages.notWritten(info)
        : () => state.messages.mismatch(info),
  }
}

/**
 * Options for `snapshotMatchers`.
 * @public
 */
export interface SnapshotMatchersOptions {
  /** Include `toMatchFileSnapshot`, which Vitest has and Jest doesn't. */
  readonly fileSnapshot: boolean
}

/**
 * The snapshot matchers a dialect's table includes, and the `.resolves`/`.rejects` form of the
 * two that read a thrown error (Jest's `getPromiseMatcher`: the settled value is the error, so the
 * matcher is told not to call it).
 * @public
 */
export function snapshotMatchers(options: SnapshotMatchersOptions): {
  readonly matchers: MatcherSet
  readonly promiseMatchers: MatcherSet
} {
  const matchers: Record<string, Matcher> = {
    toMatchSnapshot: toMatchSnapshot as unknown as Matcher,
    toMatchInlineSnapshot: toMatchInlineSnapshot as unknown as Matcher,
    toThrowErrorMatchingSnapshot: toThrowErrorMatchingSnapshot as unknown as Matcher,
    toThrowErrorMatchingInlineSnapshot: toThrowErrorMatchingInlineSnapshot as unknown as Matcher,
    ...(options.fileSnapshot
      ? { toMatchFileSnapshot: toMatchFileSnapshot as unknown as Matcher }
      : {}),
  }
  const fromPromise = (matcher: Matcher): Matcher =>
    function (this: MatcherContext, received: unknown, argument?: unknown) {
      return (matcher as unknown as (...a: unknown[]) => MatcherResult).call(
        this,
        received,
        argument,
        true,
      )
    } as unknown as Matcher
  return {
    matchers,
    promiseMatchers: {
      toThrowErrorMatchingSnapshot: fromPromise(matchers.toThrowErrorMatchingSnapshot as Matcher),
      toThrowErrorMatchingInlineSnapshot: fromPromise(
        matchers.toThrowErrorMatchingInlineSnapshot as Matcher,
      ),
    },
  }
}

/**
 * Adds a snapshot serializer to the running file's state (`expect.addSnapshotSerializer`). Jest's
 * list is the module's, which is one per test file; here it is the file's snapshot state's.
 * @internal
 */
export function addSnapshotSerializer(
  context: { snapshotState?: unknown },
  plugin: SnapshotPlugin,
): void {
  const { snapshotState } = context
  if (!isSnapshotState(snapshotState)) {
    throw new SnapshotError(
      'SNAPSHOT_NOT_INITIALIZED',
      "expect.addSnapshotSerializer() ran outside a test file's run: there is no snapshot state to add the serializer to",
    )
  }
  snapshotState.addSerializer(plugin)
}
