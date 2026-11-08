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
  SnapshotPlugin,
} from '@provino/types'
import type { MatcherContext } from './context.ts'
import { equalityTesters } from './equality.ts'
import { ExpectError } from './errors.ts'
import { createMatcherRegistry, type MatcherRegistry } from './slot.ts'
import { addSnapshotSerializer } from './snapshot-matchers.ts'
import type { StateSource } from './state.ts'

/**
 * The error a failed assertion throws under `errorShape: 'matcher-result'`: an `Error` whose text
 * is in `message`, with the matcher's result attached (Jest's `JestAssertionError`). Its `name`
 * is `Error`, so reports print `Error: …` as Jest's do.
 * @public
 */
export class MatcherResultError extends Error {
  // A field, not a declaration: like Jest's, every instance has it as an own key, set or not.
  matcherResult: (Omit<MatcherResult, 'message'> & { readonly message: string }) | undefined
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

/**
 * Jest's flag for built-in matchers (`$$jest-internal-matcher`), set on the matcher function itself.
 * Their failures are re-anchored at the caller, and they're called without the external trap.
 */
const INTERNAL_MATCHER_FLAG: unique symbol = Symbol.for('$$jest-internal-matcher')

const isInternal = (matcher: Matcher): boolean =>
  Reflect.get(matcher, INTERNAL_MATCHER_FLAG) === true

/** A matcher call under `.resolves`/`.rejects`: see `makeThrowingMatcher`. */
interface Settled {
  /** The state of the test that called the matcher. */
  readonly state: MatcherState
  /** The settle callback the call's errors are anchored above. */
  readonly above: Caller
  /** The error a failure reuses, made when the matcher was called (Jest's `innerErr`). */
  readonly error: MatcherResultError
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
  // T7.7: the policy's equality rules go ahead of Jest's `equals` and of the user's testers.
  registry.customEqualityTesters.push(...equalityTesters(policy.equality))
  const { messages } = table
  /** The table's promise forms: dialect code, so their errors are re-anchored like built-ins'. */
  const promiseForms = new WeakSet<Matcher>(Object.values(table.promiseMatchers))

  const getState = (): MatcherState => source.current()

  /**
   * One call of a matcher. `settled` is set under `.resolves`/`.rejects`; a direct call reads the
   * state now and anchors above `throwingMatcher`, as Jest does.
   */
  const makeThrowingMatcher = (
    matcher: Matcher,
    isNot: boolean,
    promise: PromiseVoice,
    actual: unknown,
    settled?: Settled,
  ) =>
    function throwingMatcher(...args: unknown[]): unknown {
      let throws = true
      const internal = isInternal(matcher)
      const state = settled?.state ?? getState()
      const above: Caller = settled?.above ?? throwingMatcher
      const matcherContext: MatcherContext = {
        ...state,
        customTesters: registry.customEqualityTesters,
        // When throws is disabled, the failure is added to the state instead of thrown (snapshot
        // matchers log every failure of a test). Jest's `() => (throws = false)` returns false.
        dontThrow: () => {
          throws = false
          return false
        },
        equals,
        utils: registry.utils,
        error: settled?.error,
        isNot,
        promise,
      }

      const processResult = (
        result: unknown,
        at: Caller,
        asyncError?: MatcherResultError,
      ): void => {
        // Inline, not `anchored(...)`: this runs on every assertion, and a closure costs.
        let valid: ValidResult
        try {
          valid = validateResult(result, messages.invalidResult)
        } catch (error) {
          throw anchor(error, at)
        }
        state.assertionCalls++
        if ((valid.pass && isNot) || (!valid.pass && !isNot)) {
          const message = getMessage(valid, messages.noMessage, at)
          // The error made at the call (settled or async) takes the message; a sync failure gets
          // its own. Assigning keeps Jest's key order (`matcherResult`, then `message`).
          let error = settled?.error ?? asyncError
          if (error) error.message = message
          else error = anchor(new MatcherResultError(message), at)
          // The result travels with the error, so a reporter can show its own diff.
          error.matcherResult = { ...valid, message }
          if (throws) throw error
          state.suppressedErrors.push(error)
        } else {
          state.numPassingAsserts++
        }
      }

      // Built-ins are re-anchored like Jest's internal matchers; so are the table's promise forms
      // under `.resolves`/`.rejects`, whose frames in Jest are in `node_modules`.
      const handleError = (error: unknown): never => {
        if (
          (internal || promiseForms.has(matcher)) &&
          typeof error === 'object' &&
          error !== null &&
          !(error instanceof MatcherResultError) &&
          Reflect.get(error, 'name') !== 'PrettyFormatPluginError'
        ) {
          Error.captureStackTrace(error, above)
        }
        throw error
      }

      const callable = matcher as unknown as Callable
      let potentialResult: unknown
      try {
        potentialResult = internal
          ? callable.call(matcherContext, actual, ...args)
          : // The frame name lets an inline snapshot find the custom matcher's call (Jest's trap).
            (function __EXTERNAL_MATCHER_TRAP__() {
              return callable.call(matcherContext, actual, ...args)
            })()
        if (isPromise(potentialResult)) {
          const asyncError = capturedError(above)
          // The thenable's own `then`, then `catch` on what it returns, as Jest does: the number of
          // ticks before the result lands decides races with the test's end. The result is
          // checked in a callback the user's stack isn't under, so its errors anchor above it.
          const chained = potentialResult.then(function onMatcherResult(result) {
            processResult(result, onMatcherResult, asyncError)
          })
          return anchored(() => (chained as Promise<void>).catch(handleError), above)
        }
        return processResult(potentialResult, above)
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
      // The state of the test that made the call, not of whatever runs the settle callback.
      const state = getState()
      const actualWrapper: unknown = typeof actual === 'function' ? actual() : actual
      if (!isPromise(actualWrapper)) {
        throw anchor(new MatcherResultError(messages.notAPromise(call, actual)), settledMatcher)
      }
      const error = capturedError(settledMatcher)
      const outerErr = outer ?? new MatcherResultError()
      const wrong = (message: string): never => {
        outerErr.message = message
        throw outerErr
      }
      const settle = (value: unknown, above: Caller): unknown =>
        makeThrowingMatcher(matcher, isNot, promise, value, { state, above, error })(...args)
      return actualWrapper.then(
        function onResolved(result) {
          if (promise === 'rejects') wrong(messages.resolvedInsteadOfRejected(call, result))
          return settle(result, onResolved)
        },
        function onRejected(reason: unknown) {
          if (promise === 'resolves') wrong(messages.rejectedInsteadOfResolved(call, reason))
          return settle(reason, onRejected)
        },
      )
    }

  /** What Jest's plain expectation object has as own keys, for this voice. */
  const keysOf = ({ isNot, promise }: Target): string[] => {
    const names = Object.keys(registry.matchers)
    if (isNot) return names
    return promise === '' ? ['not', 'rejects', 'resolves', ...names] : ['not', ...names]
  }

  /** `keysOf(target).includes(key)`, without building the list (`in` and descriptors per key). */
  const hasKey = ({ isNot, promise }: Target, key: string): boolean =>
    (key === 'not' && !isNot) ||
    ((key === 'resolves' || key === 'rejects') && !isNot && promise === '') ||
    Object.prototype.propertyIsEnumerable.call(registry.matchers, key)

  function get(target: Target, key: string | symbol, receiver: unknown): unknown {
    if (typeof key !== 'string') return undefined
    if (key === 'not') {
      if (target.isNot) return undefined
      const { actual, promise, outer } = target
      return assertion({ actual, isNot: true, promise, outer })
    }
    if (key === 'resolves' || key === 'rejects') {
      if (target.isNot || target.promise !== '') return undefined
      // `expect()` made it for a promise or a function; another thenable gets one now, while
      // the user's line is still on the stack.
      const outer = target.outer ?? capturedError(get)
      return assertion({ actual: target.actual, isNot: false, promise: key, outer })
    }
    const matcher = registry.matchers[key]
    // Anything else reads as on Jest's plain object: `Object.prototype`'s members, or undefined.
    if (matcher === undefined) return Reflect.get(Object.prototype, key, receiver)
    if (target.promise === '') return makeThrowingMatcher(matcher, target.isNot, '', target.actual)
    // Own keys only: a custom matcher named like an `Object.prototype` method is still itself.
    const promiseForm = Object.hasOwn(table.promiseMatchers, key)
      ? table.promiseMatchers[key]
      : undefined
    return makeSettledMatcher(key, promiseForm ?? matcher, target)
  }

  const handler: ProxyHandler<Target> = {
    get,
    // Enumeration sees Jest's keys (wrappers such as jest-expect-message walk them), at no cost to
    // property access.
    ownKeys: (target) => keysOf(target),
    has: (target, key) =>
      (typeof key === 'string' && hasKey(target, key)) || key in Object.prototype,
    getOwnPropertyDescriptor(target, key) {
      if (typeof key !== 'string' || !hasKey(target, key)) return undefined
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: get(target, key, target),
      }
    },
  }

  const assertion = (target: Target): Assertion =>
    new Proxy(target, handler) as unknown as Assertion

  function expect(actual: unknown, ...rest: unknown[]): Assertion {
    if (rest.length > 0) throw anchor(new Error(messages.tooManyArguments()), expect)
    // Jest makes the error a wrong settlement throws in `expect()` itself (index.ts L117), so it
    // points at the `expect(` call. Only a promise or a function can reach `.resolves`/`.rejects`,
    // so only they pay for a stack here; the check reads no property of the value.
    const outer =
      typeof actual === 'function' || types.isPromise(actual) ? capturedError(expect) : undefined
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

  /** Jest's `setMatchers` (jestMatchersObject.ts L56–L117), key by key. */
  const register = (matchers: MatcherSet, internal: boolean, caller: Caller): void => {
    for (const name of anchored(() => Object.keys(matchers), caller)) {
      const matcher = matchers[name]
      if (typeof matcher !== 'function') {
        throw anchor(new TypeError(messages.invalidMatcher(name, matcher)), caller)
      }
      // The flag goes on the function, non-writable, as in Jest: registering a built-in again as
      // a custom matcher, or a frozen function, throws Jest's TypeError.
      anchored(
        () => Object.defineProperty(matcher, INTERNAL_MATCHER_FLAG, { value: internal }),
        caller,
      )
      if (!internal) {
        // One builder per registration, like Jest's one `CustomMatcher` class per key.
        const build = table.customAsymmetric(name, matcher)
        defineAsymmetric(expect, name, (...sample: unknown[]) => build(false, sample))
        defineAsymmetric(not, name, (...sample: unknown[]) => build(true, sample))
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
    const error = anchor(new Error(), assertions)
    Object.assign(getState(), {
      expectedAssertionsNumber: expected,
      expectedAssertionsNumberError: error,
    })
  }

  function hasAssertions(...args: unknown[]): void {
    const error = anchor(new Error(), hasAssertions)
    anchored(() => messages.ensureNoExpected(args[0], '.hasAssertions'), hasAssertions)
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
    addSnapshotSerializer(plugin: SnapshotPlugin): void {
      addSnapshotSerializer(getState(), plugin)
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

/**
 * Jest's `_validateResult` (index.ts L422–L438): `{ pass: boolean, message?: string | function }`.
 * Its expression is kept as written, so a `null` result reads `.pass` and throws V8's
 * `Cannot read properties of null (reading 'pass')`, as in Jest.
 */
function validateResult(result: unknown, invalid: (result: unknown) => string): ValidResult {
  const shaped = result as { readonly pass?: unknown; readonly message?: unknown }
  if (
    typeof result !== 'object' ||
    typeof shaped.pass !== 'boolean' ||
    (shaped.message && typeof shaped.message !== 'string' && typeof shaped.message !== 'function')
  ) {
    throw new Error(invalid(result))
  }
  return result as ValidResult
}

/**
 * Jest's `getMessage`: `(message && message()) || noMessage`. A string `message` passes
 * validation and then throws `message is not a function` here, as in Jest; the name `message` is
 * kept for that text, and only that error, thrown from this frame, is anchored above `above`. An
 * error a custom matcher's own `message` throws keeps its frames, as in Jest.
 */
function getMessage(result: ValidResult, noMessage: () => string, above: Caller): string {
  const raw: unknown = result.message
  if (raw && typeof raw !== 'function') {
    // Calling it throws V8's `message is not a function`, from this frame.
    const message = raw as () => string
    return anchored(() => message(), above)
  }
  const message = raw as (() => string) | undefined
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

/**
 * An empty `MatcherResultError` whose stack starts above `above`. The constructor's own stack is
 * switched off, since `captureStackTrace` replaces it anyway: on `expect(fn)`, `expect(promise)` and
 * every `.resolves`/`.rejects` call that halves the cost. The header is still taken lazily, so a
 * message set later shows in it.
 */
function capturedError(above: Caller): MatcherResultError {
  if (!Object.hasOwn(Error, 'stackTraceLimit')) return anchor(new MatcherResultError(), above)
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 0
  let error: MatcherResultError
  try {
    error = new MatcherResultError()
  } finally {
    Error.stackTraceLimit = limit
  }
  Error.captureStackTrace(error, above)
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
