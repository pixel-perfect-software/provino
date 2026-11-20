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
  PendingAssertion,
  PromiseVoice,
  SnapshotPlugin,
} from '@provino/types'
import type { MatcherContext } from './context.ts'
import { equalityTesters } from './equality.ts'
import { ExpectError } from './errors.ts'
import { awaitable } from './internal/awaitable.ts'
import { createPoll, type PollTimers } from './poll.ts'
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
 * Whether the engine holds an unawaited `.resolves`/`.rejects`/`expect.poll` against the test:
 * `'fail'` tracks them and `endOfTest` reports each that is left; `'ignore'` (Jest) does neither,
 * and the assertion is the plain promise it always was. `CorePolicy.unawaitedAsyncAssertion`
 * decides it; the worker passes it in, because this package reads only its own slice.
 * @public
 */
export type UnawaitedAssertion = 'ignore' | 'fail'

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
  /** Default `'ignore'`. */
  readonly unawaited?: UnawaitedAssertion
  /** What `expect.poll` waits with: the file's fake clock and, in tests, a manual scheduler. */
  readonly pollTimers?: PollTimers
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
  /** A try of `expect.poll`: the matcher's context says so (`this.poll`), as Vitest's does. */
  readonly poll?: true
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
  /**
   * Under `errorShape: 'assertion-error'`, made when `.resolves`/`.rejects` is read: the stack a
   * settled failure and an unawaited assertion report.
   */
  readonly read?: MatcherResultError
  /** `expect.soft`: a failure is recorded in the state and the test goes on. */
  readonly soft: boolean
  /** `expect(actual, message)`, where the table takes one (`ExpectTable.messageArgument`). */
  readonly message: string | undefined
}

/**
 * Builds a dialect's `expect`. Throws `EXPECT_NOT_IMPLEMENTED` for policy values a later task
 * builds, rather than running them half-way.
 * @public
 */
export function createExpect(options: CreateExpectOptions): ExpectStatic {
  const { policy, table, source } = options
  checkPolicy(policy, table)
  const track = options.unawaited === 'fail'
  const registry = options.registry ?? createMatcherRegistry()
  registry.utils = table.utils
  // T7.7: the policy's equality rules go ahead of Jest's `equals`, after the user's testers:
  // Vitest's `equals` asks the custom testers first and judges errors and dates itself after them.
  const policyTesters = equalityTesters(policy.equality)
  registry.customEqualityTesters.push(...policyTesters)
  const { messages } = table
  /** The table's `equals` for a matcher's `this.equals`, else Jest's. */
  const tableEquals = (table.equals ?? equals) as typeof equals
  /** What a passing sync matcher call returns under this table. */
  const matcherReturn = table.matcherReturn?.bind(table)
  /**
   * `ExpectPolicy.assertionCalls`: `per-expect-call` counts an assertion when `expect()` (or
   * `expect.soft()`, `expect.poll()`) is called, whatever then runs on it; `per-matcher-call`
   * counts each matcher call that returns a result.
   */
  const perExpect = policy.assertionCalls === 'per-expect-call'
  /** How many arguments `expect` takes after the value: a table may take a message. */
  const maxRest = table.messageArgument === true ? 1 : 0
  /**
   * `errorShape: 'assertion-error'`: a failure throws the table's own error, made by its
   * `assertionError`, and `.resolves`/`.rejects` check the value and take the call's stack when
   * they are read (an `AssertionError` runner does both there). `undefined` under `matcher-result`.
   */
  const assertionError =
    policy.errorShape === 'assertion-error' ? table.assertionError?.bind(table) : undefined
  /** The table's promise forms: dialect code, so their errors are re-anchored like built-ins'. */
  const promiseForms = new WeakSet<Matcher>(Object.values(table.promiseMatchers))

  const getState = (): MatcherState => source.current()

  /**
   * One call of a matcher. `settled` is set under `.resolves`/`.rejects`; a direct call reads the
   * state now and anchors above `throwingMatcher`, as Jest does.
   */
  const makeThrowingMatcher = (
    matcherName: string,
    matcher: Matcher,
    isNot: boolean,
    promise: PromiseVoice,
    actual: unknown,
    settled?: Settled,
    soft = false,
    customMessage?: string,
  ) =>
    function throwingMatcher(...args: unknown[]): unknown {
      // A soft assertion records its failure, as `dontThrow()` does, and the test goes on.
      let throws = !soft
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
        equals: tableEquals,
        utils: registry.utils,
        error: settled?.error,
        isNot,
        promise,
        ...(customMessage === undefined ? {} : { customMessage }),
        // `expect.soft` and `expect.poll` say so to the matcher, as Vitest's `getMatcherState` does.
        ...(soft ? { soft: true } : {}),
        ...(settled?.poll === true ? { poll: true } : {}),
      }

      const processResult = (
        result: unknown,
        at: Caller,
        asyncError?: MatcherResultError,
      ): boolean => {
        // Inline, not `anchored(...)`: this runs on every assertion, and a closure costs.
        let valid: ValidResult
        try {
          valid = validateResult(result, messages.invalidResult)
        } catch (error) {
          throw anchor(error, at)
        }
        if (!perExpect) state.assertionCalls++
        if ((valid.pass && isNot) || (!valid.pass && !isNot)) {
          const message = getMessage(valid, messages.noMessage, at)
          if (assertionError !== undefined) {
            const made = assertionError(valid as MatcherResult, message, {
              matcherName,
              isNot,
              promise,
              ...(customMessage === undefined ? {} : { message: customMessage }),
            })
            // A settled call reports at its `.resolves`/`.rejects`; anything else where it failed.
            const thrown = settled === undefined ? anchor(made, at) : restack(made, settled.error)
            if (throws) throw thrown
            state.suppressedErrors.push(thrown)
            return false
          }
          // The error made at the call (settled or async) takes the message; a sync failure gets
          // its own. Assigning keeps Jest's key order (`matcherResult`, then `message`).
          let error = settled?.error ?? asyncError
          if (error) error.message = message
          else error = anchor(new MatcherResultError(message), at)
          // The result travels with the error, so a reporter can show its own diff.
          error.matcherResult = { ...valid, message }
          if (throws) throw error
          state.suppressedErrors.push(error)
          return false
        }
        state.numPassingAsserts++
        return true
      }

      // Built-ins are re-anchored like Jest's internal matchers; so are the table's promise forms
      // under `.resolves`/`.rejects`, whose frames in Jest are in `node_modules`.
      const handleError = (error: unknown): never => {
        // An `AssertionError` runner gives what a settled call throws the stack of the call.
        if (assertionError !== undefined && settled !== undefined && error instanceof Error) {
          throw restack(error, settled.error)
        }
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
          : // The frame name lets an inline snapshot find the custom matcher's call (Jest's trap;
            // `call-stack.ts` cuts at it and at `throwingMatcher`).
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
        // A matcher that passed returns what the table says a call returns (Vitest's assertion, to
        // chain on); `undefined` otherwise, as in Jest.
        if (
          processResult(potentialResult, above) &&
          matcherReturn !== undefined &&
          settled === undefined
        ) {
          return matcherReturn(actual, {
            matcherName,
            isNot,
            promise,
            ...(customMessage === undefined ? {} : { message: customMessage }),
          })
        }
        return undefined
      } catch (error) {
        return handleError(error)
      }
    }

  const makeSettledMatcher = (
    matcherName: string,
    matcher: Matcher,
    { actual, isNot, promise, outer, soft, message, read }: Target,
  ) =>
    function settledMatcher(...args: unknown[]): PromiseLike<unknown> {
      const call: MatcherCall = { matcherName, isNot, promise }
      // The state of the test that made the call, not of whatever runs the settle callback.
      const state = getState()
      const actualWrapper: unknown = typeof actual === 'function' ? actual() : actual
      if (!isPromise(actualWrapper)) {
        throw anchor(new MatcherResultError(messages.notAPromise(call, actual)), settledMatcher)
      }
      // An `AssertionError` runner reports a failure at the `.resolves`/`.rejects` it was read through.
      const error = read ?? capturedError(settledMatcher)
      const outerErr = outer ?? new MatcherResultError()
      const wrong = (
        message: string,
        value: unknown,
        settlement: 'resolved' | 'rejected',
      ): never => {
        if (assertionError !== undefined) {
          // The table's own error for it (Vitest's `AssertionError`, with its diff), on the
          // frames of the `.resolves`/`.rejects` read.
          const result = { pass: false, message: () => message, actual: value }
          throw restack(assertionError(result, message, { ...call, settlement }), outerErr)
        }
        outerErr.message = message
        throw outerErr
      }
      const settle = (value: unknown, above: Caller): unknown =>
        makeThrowingMatcher(
          matcherName,
          matcher,
          isNot,
          promise,
          value,
          { state, above, error },
          soft,
          message,
        )(...args)
      const chained = actualWrapper.then(
        function onResolved(result) {
          if (promise === 'rejects') {
            wrong(messages.resolvedInsteadOfRejected(call, result), result, 'resolved')
          }
          return settle(result, onResolved)
        },
        function onRejected(reason: unknown) {
          if (promise === 'resolves') {
            wrong(messages.rejectedInsteadOfResolved(call, reason), reason, 'rejected')
          }
          return settle(reason, onRejected)
        },
      )
      // A soft assertion never rejects: whatever went wrong is the test's, at its end.
      const outcome = soft
        ? Promise.resolve(chained).then(undefined, (failure: unknown) => {
            state.suppressedErrors.push(
              failure instanceof Error ? failure : new Error(String(failure)),
            )
          })
        : chained
      if (!track) return outcome
      // Unawaited-assertion tracking: it stays in the state until someone takes its result.
      // Nobody may be listening, and a rejection then is reported as the unawaited assertion it is.
      const pending: PendingAssertion = {
        kind: 'settled',
        call,
        // Under `assertion-error`, the `.resolves`/`.rejects` read, as Vitest records it there.
        error: read === undefined ? capturedError(settledMatcher) : withFramesOf(read),
      }
      state.pendingAsync.add(pending)
      Promise.resolve(outcome).catch(() => undefined)
      return awaitable(
        () => Promise.resolve(outcome),
        () => {
          state.pendingAsync.delete(pending)
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
      const { actual, promise, outer, soft, message, read } = target
      return assertion({
        actual,
        isNot: true,
        promise,
        outer,
        soft,
        message,
        ...(read === undefined ? {} : { read }),
      })
    }
    if (key === 'resolves' || key === 'rejects') {
      if (target.isNot || target.promise !== '') return undefined
      if (assertionError !== undefined) {
        // Checked as it is read, where a `.rejects` of a function calls it, and the call's stack is
        // the read's.
        const outer = capturedError(get)
        const read = capturedError(get)
        const value =
          key === 'rejects' && typeof target.actual === 'function' ? target.actual() : target.actual
        if (!isPromise(value)) {
          const call: MatcherCall = { matcherName: '', isNot: false, promise: key }
          throw anchor(new TypeError(messages.notAPromise(call, value)), get)
        }
        return assertion({
          actual: value,
          isNot: false,
          promise: key,
          outer,
          read,
          soft: target.soft,
          message: target.message,
        })
      }
      // `expect()` made it for a promise or a function; another thenable gets one now, while
      // the user's line is still on the stack.
      const outer = target.outer ?? capturedError(get)
      return assertion({
        actual: target.actual,
        isNot: false,
        promise: key,
        outer,
        soft: target.soft,
        message: target.message,
      })
    }
    const matcher = registry.matchers[key]
    if (matcher === undefined) {
      // Anything else reads as on Jest's plain object: `Object.prototype`'s members, or undefined;
      // or, where the table has chains (Chai's `to`, `be`, …), as the table's chain of that name. A
      // thenable check (`then`) is never a chain, so it loads nothing.
      if (table.chain === undefined || key === 'then' || key in Object.prototype) {
        return Reflect.get(Object.prototype, key, receiver)
      }
      const { actual, isNot, promise, message } = target
      // Counted per matcher call, a chain counts once, here, since none of its calls reach the
      // engine; counted per `expect()` call, `expect()` counted it.
      if (!perExpect) getState().assertionCalls++
      return table.chain(actual, key, {
        matcherName: key,
        isNot,
        promise,
        ...(message === undefined ? {} : { message }),
      })
    }
    if (target.promise === '') {
      return makeThrowingMatcher(
        key,
        matcher,
        target.isNot,
        '',
        target.actual,
        undefined,
        target.soft,
        target.message,
      )
    }
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
    if (rest.length > maxRest) throw anchor(new Error(messages.tooManyArguments()), expect)
    // Jest makes the error a wrong settlement throws in `expect()` itself (index.ts L117), so it
    // points at the `expect(` call. Only a promise or a function can reach `.resolves`/`.rejects`,
    // so only they pay for a stack here; the check reads no property of the value.
    const outer =
      typeof actual === 'function' || types.isPromise(actual) ? capturedError(expect) : undefined
    if (perExpect) getState().assertionCalls++
    return assertion({
      actual,
      isNot: false,
      promise: '',
      outer,
      soft: false,
      message: rest[0] as string | undefined,
    })
  }

  /** `expect`, but a failed assertion is recorded and the test goes on. */
  function soft(actual: unknown, ...rest: unknown[]): Assertion {
    if (rest.length > maxRest) throw anchor(new Error(messages.tooManyArguments()), soft)
    if (source.current() === source.file()) {
      throw anchor(new ExpectError('EXPECT_OUTSIDE_TEST', messages.outsideTest('soft')), soft)
    }
    const outer =
      typeof actual === 'function' || types.isPromise(actual) ? capturedError(soft) : undefined
    if (perExpect) getState().assertionCalls++
    return assertion({
      actual,
      isNot: false,
      promise: '',
      outer,
      soft: true,
      message: rest[0] as string | undefined,
    })
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
    // The policy's testers stay last.
    const { customEqualityTesters } = registry
    customEqualityTesters.splice(customEqualityTesters.length - policyTesters.length, 0, ...testers)
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

  /** `expect.unreachable(message)`: only on a dialect whose table words it. */
  const unreachableText = messages.unreachable?.bind(messages)
  function unreachable(message?: string): never {
    throw anchor(new MatcherResultError(unreachableText?.(message)), unreachable)
  }

  const poll = policy.poll.enabled
    ? createPoll({
        policy,
        messages,
        timers: options.pollTimers,
        track,
        state: getState,
        inTest: () => source.current() !== source.file(),
        hasMatcher: (name) => registry.matchers[name] !== undefined,
        capture: capturedError,
        run: function pollTry(name, isNot, value, args, state) {
          const matcher = registry.matchers[name]
          if (matcher === undefined) throw new TypeError(`${name} is not a matcher`)
          const error = capturedError(pollTry)
          return makeThrowingMatcher(name, matcher, isNot, '', value, {
            state,
            above: pollTry,
            error,
            poll: true,
          })(...args)
        },
      })
    : undefined

  /** `expect.poll`, counted once per call when assertions are counted per `expect()` call. */
  const countedPoll: typeof poll =
    poll === undefined || !perExpect
      ? poll
      : (...args: Parameters<typeof poll>): ReturnType<typeof poll> => {
          getState().assertionCalls++
          return poll(...args)
        }

  const statics = {
    ...table.asymmetric,
    ...(policy.soft ? { soft } : {}),
    ...(countedPoll === undefined ? {} : { poll: countedPoll }),
    ...(unreachableText === undefined ? {} : { unreachable }),
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

/** The policy values the engine builds; the rest throw rather than run half-way. */
function checkPolicy(policy: ExpectPolicy, table: ExpectTable): void {
  const missing: string[] = []
  if (policy.matcherTable === null) {
    throw new ExpectError(
      'EXPECT_NO_MATCHER_TABLE',
      'ExpectPolicy.matcherTable is null: the neutral matcher table is not built yet',
    )
  }
  if (policy.errorShape === 'assertion-error' && table.assertionError === undefined) {
    missing.push(`errorShape: 'assertion-error' with a table that has no assertionError`)
  }
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
  return (message && message()) || anchored(noMessage, above)
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

/** The frames of `captured`'s stack, from the newline that ends its header. */
function framesOf(captured: Error): string {
  const stack = captured.stack ?? ''
  const head = captured.message === '' ? captured.name : `${captured.name}: ${captured.message}`
  return stack.startsWith(head) ? stack.slice(head.length) : stack.slice(stack.indexOf('\n'))
}

/**
 * A new error with `captured`'s frames, whose header reads its own message when the stack is read:
 * a message set later (the end-of-test check words an unawaited assertion) still shows.
 */
function withFramesOf(captured: Error): MatcherResultError {
  const error = new MatcherResultError()
  const frames = framesOf(captured)
  let set: string | undefined
  Object.defineProperty(error, 'stack', {
    configurable: true,
    get: () => set ?? `${error.name}${error.message === '' ? '' : `: ${error.message}`}${frames}`,
    set: (value: string) => {
      set = value
    },
  })
  return error
}

/**
 * Gives `error` the frames of `captured` (made where the user called), under a header of its own
 * message: the stack an `AssertionError` runner reports for an async assertion.
 */
function restack<E extends Error>(error: E, captured: Error): E {
  error.stack = `${captured.name}: ${error.message}${framesOf(captured)}`
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
