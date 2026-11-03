// The lazy front end (T7.3, Track 7 R1, spike F). Jest's `expect(x)` builds 36 matchers × 6
// voices of closures and an error on every call (`expect/src/index.ts` L105–L157). Here `expect(x)`
// is a Proxy: `not`, `resolves`, `rejects` and the matcher name resolve on property access, and
// only the one matcher called gets a closure. A call then follows Jest's `makeThrowingMatcher`
// (L275–L395) step for step: the context, the external-matcher trap frame, `dontThrow`, async
// results, and the error reused under `.resolves`/`.rejects`. Every word printed comes from the
// dialect's table.
//
// Our source runs from `packages/*/src`, which the harness reads as user code, so every error
// made or rethrown here is anchored with `Error.captureStackTrace` above our own frames: its top
// frame is the user's call, as with Jest's frames in `node_modules`.
import { types } from 'node:util'
import { equals } from '@jest/expect-utils'
import type {
  Assertion,
  EqualityTester,
  ExpectPolicy,
  ExpectStatic,
  ExpectTable,
  Matcher,
  MatcherCall,
  MatcherResult,
  MatcherSet,
  MatcherState,
  PromiseVoice,
} from '@provino/types'
import type { MatcherContext } from './context.ts'
import { ExpectError } from './errors.ts'
import { createMatcherRegistry, type MatcherRegistry } from './slot.ts'
import type { StateSource } from './state.ts'

/**
 * The error a failed assertion throws under `errorShape: 'matcher-result'`: an `Error` whose text
 * is in `message`, with the matcher's result attached (Jest's `JestAssertionError`). Its `name`
 * is `Error`, so reports print `Error: …` as Jest's do.
 * @public
 */
export class MatcherResultError extends Error {
  declare matcherResult?: Omit<MatcherResult, 'message'> & { readonly message: string }
}

/**
 * What `createExpect` needs.
 * @public
 */
export interface CreateExpectOptions {
  readonly policy: ExpectPolicy
  /** The dialect's table, loaded from `policy.matcherTable`. */
  readonly table: ExpectTable
  readonly source: StateSource
  /** The registry the slot was installed with; a fresh one when there is no slot. */
  readonly registry?: MatcherRegistry
}

/** A matcher as the engine calls it. */
type Callable = (this: MatcherContext, received: unknown, ...expected: unknown[]) => unknown

/** The data behind one `expect(x)` (and its `.not`, `.resolves`, `.rejects`) Proxy. */
interface Target {
  readonly actual: unknown
  readonly isNot: boolean
  readonly promise: PromiseVoice
  /** Made when `.resolves`/`.rejects` is read: the error a wrong settlement throws. */
  readonly outer: MatcherResultError | undefined
}

/**
 * Builds a dialect's `expect`. Throws `EXPECT_NOT_IMPLEMENTED` for policy values a later task
 * builds, rather than running them half-way.
 * @public
 */
export function createExpect(options: CreateExpectOptions): ExpectStatic {
  const { policy, table, source } = options
  checkPolicy(policy)
  const registry = options.registry ?? createMatcherRegistry()
  registry.utils = table.utils
  const { messages } = table
  /** Built-ins: their stack frames are re-anchored like Jest's internal matchers. */
  const internal = new WeakSet<Matcher>()

  const getState = (): MatcherState => source.current()

  const makeThrowingMatcher = (
    matcher: Matcher,
    isNot: boolean,
    promise: PromiseVoice,
    actual: unknown,
    err?: MatcherResultError,
  ) =>
    function throwingMatcher(...args: unknown[]): unknown {
      let throws = true
      const state = getState()
      const matcherContext: MatcherContext = {
        ...state,
        customTesters: registry.customEqualityTesters,
        // When throws is disabled, the failure is added to the state instead of thrown (snapshot
        // matchers log every failure of a test).
        dontThrow: () => {
          throws = false
        },
        equals,
        utils: registry.utils,
        error: err,
        isNot,
        promise,
      }

      const processResult = (result: unknown, asyncError?: MatcherResultError): void => {
        const valid = anchored(
          () => validateResult(result, messages.invalidResult),
          throwingMatcher,
        )
        state.assertionCalls++
        if ((valid.pass && isNot) || (!valid.pass && !isNot)) {
          const message = anchored(() => getMessage(valid, messages.noMessage), throwingMatcher)
          let error: MatcherResultError
          if (err) {
            error = err
            error.message = message
          } else if (asyncError) {
            error = asyncError
            error.message = message
          } else {
            error = new MatcherResultError(message)
            Error.captureStackTrace(error, throwingMatcher)
          }
          // The result travels with the error, so a reporter can show its own diff.
          error.matcherResult = { ...valid, message }
          if (throws) throw error
          state.suppressedErrors.push(error)
        } else {
          state.numPassingAsserts++
        }
      }

      const handleError = (error: unknown): never => {
        if (
          internal.has(matcher) &&
          typeof error === 'object' &&
          error !== null &&
          !(error instanceof MatcherResultError) &&
          Reflect.get(error, 'name') !== 'PrettyFormatPluginError'
        ) {
          Error.captureStackTrace(error, throwingMatcher)
        }
        throw error
      }

      const callable = matcher as unknown as Callable
      let potentialResult: unknown
      try {
        potentialResult = internal.has(matcher)
          ? callable.call(matcherContext, actual, ...args)
          : // The frame name lets an inline snapshot find the custom matcher's call (Jest's trap).
            (function __EXTERNAL_MATCHER_TRAP__() {
              return callable.call(matcherContext, actual, ...args)
            })()
        if (isPromise(potentialResult)) {
          const asyncError = new MatcherResultError()
          Error.captureStackTrace(asyncError, throwingMatcher)
          // The thenable's own `then`, then `catch` on what it returns, as Jest does: the number of
          // ticks before the result lands decides races with the test's end.
          return (
            potentialResult.then((result) => processResult(result, asyncError)) as Promise<void>
          ).catch(handleError)
        }
        return processResult(potentialResult)
      } catch (error) {
        return handleError(error)
      }
    }

  const makeSettledMatcher = (
    matcherName: string,
    matcher: Matcher,
    { actual, isNot, promise, outer }: Target,
  ) =>
    function settledMatcher(...args: unknown[]): PromiseLike<unknown> {
      const call: MatcherCall = { matcherName, isNot, promise }
      const actualWrapper: unknown = typeof actual === 'function' ? actual() : actual
      if (!isPromise(actualWrapper)) {
        throw anchor(new MatcherResultError(messages.notAPromise(call, actual)), settledMatcher)
      }
      const innerErr = new MatcherResultError()
      Error.captureStackTrace(innerErr, settledMatcher)
      const outerErr = outer ?? new MatcherResultError()
      return actualWrapper.then(
        (result) => {
          if (promise === 'rejects') {
            outerErr.message = messages.resolvedInsteadOfRejected(call, result)
            throw outerErr
          }
          return makeThrowingMatcher(matcher, isNot, promise, result, innerErr)(...args)
        },
        (reason: unknown) => {
          if (promise === 'resolves') {
            outerErr.message = messages.rejectedInsteadOfResolved(call, reason)
            throw outerErr
          }
          return makeThrowingMatcher(matcher, isNot, promise, reason, innerErr)(...args)
        },
      )
    }

  const handler: ProxyHandler<Target> = {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key === 'not') return target.isNot ? undefined : assertion({ ...target, isNot: true })
      if (key === 'resolves' || key === 'rejects') {
        if (target.isNot || target.promise !== '') return undefined
        // `expect()` made it for a promise or a function; another thenable gets one now, while
        // the user's line is still on the stack.
        let { outer } = target
        if (outer === undefined) {
          outer = new MatcherResultError()
          Error.captureStackTrace(outer, handler.get)
        }
        return assertion({ ...target, promise: key, outer })
      }
      const matcher = registry.matchers[key]
      if (matcher === undefined) return undefined
      if (target.promise === '')
        return makeThrowingMatcher(matcher, target.isNot, '', target.actual)
      return makeSettledMatcher(key, table.promiseMatchers[key] ?? matcher, target)
    },
  }

  const assertion = (target: Target): Assertion =>
    new Proxy(target, handler) as unknown as Assertion

  function expect(actual: unknown, ...rest: unknown[]): Assertion {
    if (rest.length > 0) throw anchor(new Error(messages.tooManyArguments()), expect)
    // Jest makes the error a wrong settlement throws in `expect()` itself (index.ts L117), so it
    // points at the `expect(` call. Only a promise or a function can reach `.resolves`/`.rejects`,
    // so only they pay for a stack here; the check reads no property of the value.
    let outer: MatcherResultError | undefined
    if (typeof actual === 'function' || types.isPromise(actual)) {
      outer = new MatcherResultError()
      Error.captureStackTrace(outer, expect)
    }
    return assertion({ actual, isNot: false, promise: '', outer })
  }

  const not: Record<string, unknown> = { ...table.asymmetricNot }

  const defineAsymmetric = (owner: object, name: string, value: unknown): void => {
    Object.defineProperty(owner, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }

  const register = (matchers: MatcherSet, isInternal: boolean, caller: Caller): void => {
    for (const name of Object.keys(matchers)) {
      const matcher = matchers[name]
      if (typeof matcher !== 'function') {
        throw anchor(new TypeError(messages.invalidMatcher(name, matcher)), caller)
      }
      if (isInternal) {
        internal.add(matcher)
      } else {
        internal.delete(matcher)
        defineAsymmetric(expect, name, (...sample: unknown[]) =>
          table.customAsymmetric(name, matcher, false, sample),
        )
        defineAsymmetric(not, name, (...sample: unknown[]) =>
          table.customAsymmetric(name, matcher, true, sample),
        )
      }
    }
    Object.assign(registry.matchers, matchers)
  }

  function extend(matchers: MatcherSet): void {
    register(matchers, false, extend)
  }

  function addEqualityTesters(testers: readonly EqualityTester[]): void {
    if (!Array.isArray(testers)) {
      throw anchor(new TypeError(messages.invalidTesters(testers)), addEqualityTesters)
    }
    registry.customEqualityTesters.push(...testers)
  }

  function assertions(expected: number): void {
    const error = new Error()
    Error.captureStackTrace(error, assertions)
    Object.assign(getState(), {
      expectedAssertionsNumber: expected,
      expectedAssertionsNumberError: error,
    })
  }

  function hasAssertions(...args: unknown[]): void {
    const error = new Error()
    Error.captureStackTrace(error, hasAssertions)
    try {
      messages.ensureNoExpected(args[0], '.hasAssertions')
    } catch (cause) {
      throw anchor(cause, hasAssertions)
    }
    Object.assign(getState(), { isExpectingAssertions: true, isExpectingAssertionsError: error })
  }

  const statics = {
    ...table.asymmetric,
    not,
    extend,
    addEqualityTesters,
    assertions,
    hasAssertions,
    getState,
    setState(state: Partial<MatcherState>): void {
      Object.assign(getState(), state)
    },
  }
  register(table.matchers, true, createExpect)
  return Object.assign(expect, statics) as unknown as ExpectStatic
}

/** The policy values B08 builds; the rest throw rather than run half-way. */
function checkPolicy(policy: ExpectPolicy): void {
  const missing: string[] = []
  if (policy.matcherTable === null) {
    throw new ExpectError(
      'EXPECT_NO_MATCHER_TABLE',
      'ExpectPolicy.matcherTable is null: the neutral matcher table is not built yet',
    )
  }
  if (policy.errorShape !== 'matcher-result')
    missing.push(`errorShape: '${policy.errorShape}' (T7.6)`)
  if (policy.equality.errors !== 'message') missing.push(`equality.errors: 'assert' (T7.7)`)
  if (policy.equality.invalidDate !== 'unequal')
    missing.push(`equality.invalidDate: 'equal' (T7.7)`)
  if (policy.soft) missing.push('soft (T7.8)')
  if (policy.poll.enabled) missing.push('poll (T7.8)')
  if (policy.requireAssertions) missing.push('requireAssertions (T7.8)')
  if (missing.length > 0) {
    throw new ExpectError('EXPECT_NOT_IMPLEMENTED', `not built yet: ${missing.join(', ')}`)
  }
}

/** Jest's `jest-util` `isPromise`: any thenable. */
function isPromise(candidate: unknown): candidate is PromiseLike<unknown> {
  return (
    candidate != null &&
    (typeof candidate === 'object' || typeof candidate === 'function') &&
    typeof Reflect.get(candidate, 'then') === 'function'
  )
}

/** A matcher result after Jest's `_validateResult`. */
interface ValidResult {
  readonly pass: boolean
  readonly message?: unknown
  readonly [key: string]: unknown
}

/** Jest's `_validateResult`: `{ pass: boolean, message?: string | function }`. */
function validateResult(result: unknown, invalid: (result: unknown) => string): ValidResult {
  if (
    typeof result !== 'object' ||
    result === null ||
    typeof Reflect.get(result, 'pass') !== 'boolean'
  ) {
    throw new Error(invalid(result))
  }
  const message: unknown = Reflect.get(result, 'message')
  if (message && typeof message !== 'string' && typeof message !== 'function') {
    throw new Error(invalid(result))
  }
  return result as ValidResult
}

/**
 * Jest's `getMessage`: `(message && message()) || noMessage`. A string `message` passes
 * validation and then throws `message is not a function` here, as in Jest; the name `message` is
 * kept for that text.
 */
function getMessage(result: ValidResult, noMessage: () => string): string {
  const message = result.message as (() => string) | undefined
  // biome-ignore lint/complexity/useOptionalChain: Jest's `&&` lets a falsy `message` (`''`, `false`) mean "no message"; `?.()` would call it
  return (message && message()) || noMessage()
}

/** A function whose frame, and every frame above it, an anchored error leaves out. */
type Caller = (...args: never[]) => unknown

/** Re-anchors an error the engine throws so its top frame is the user's call. */
function anchor<E>(error: E, above: Caller): E {
  if (typeof error === 'object' && error !== null) Error.captureStackTrace(error, above)
  return error
}

/** Runs `fn`, re-anchoring what it throws above `above`. */
function anchored<R>(fn: () => R, above: Caller): R {
  try {
    return fn()
  } catch (error) {
    throw anchor(error, above)
  }
}
