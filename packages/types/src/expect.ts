// Track 7 §Types: the contract between the neutral `expect` engine (`@provino/expect`) and a
// dialect's matcher table, plus the first cut of the matcher registry. The engine owns the front
// end, the per-test state and the global slot; the table owns every matcher, every asymmetric
// matcher, `this.utils` and every word the engine prints. Augmentation, the context supertype
// and the Jest/Vitest bridges are T7.13's (Phase 2).
import type { SnapshotPlugin } from './policy/snapshot.ts'

/**
 * What an equality tester's `this` is: the deep equality it may recurse with.
 * @public
 */
export interface TesterContext {
  equals(a: unknown, b: unknown, customTesters?: EqualityTester[], strictCheck?: boolean): boolean
}

/**
 * A custom equality tester (`expect.addEqualityTesters`): `undefined` defers to the next tester.
 * The same shape as Jest's `Tester`, so either kind fits where the other is expected.
 * @public
 */
export type EqualityTester = (
  this: TesterContext,
  a: unknown,
  b: unknown,
  customTesters: EqualityTester[],
) => boolean | undefined

/**
 * A matcher's verdict. `message` is a thunk: building it is skipped when the assertion passes.
 * @public
 */
export interface MatcherResult {
  readonly pass: boolean
  readonly message: () => string
  readonly actual?: unknown
  readonly expected?: unknown
}

/**
 * One matcher: `(received, ...expected) → { pass, message }`. Parameters are `never` so a
 * matcher may type them (`(received: number, floor: number) => …`); its `this` is the engine's
 * `MatcherContext`.
 * @public
 */
export type Matcher = (
  received: never,
  ...expected: never[]
) => MatcherResult | Promise<MatcherResult>

/**
 * A set of matchers by name (`expect.extend`'s argument, a plugin's `matchers` contribution).
 * Runs in the worker.
 * @public
 */
export interface MatcherSet {
  readonly [name: string]: Matcher
}

/**
 * Per-test matcher state (Track 7 §Per-test state, plus Jest 30.5's fields). Matchers read it as
 * `this`; `expect.getState()` returns it. Mutable: the engine counts into it.
 * @public
 */
export interface MatcherState {
  assertionCalls: number
  expectedAssertionsNumber: number | null
  expectedAssertionsNumberError?: Error
  isExpectingAssertions: boolean
  isExpectingAssertionsError?: Error
  numPassingAsserts: number
  /** Failures held back by `dontThrow()` (snapshot matchers, `expect.soft`) until the test ends. */
  suppressedErrors: Error[]
  /**
   * Async assertions (`.resolves`/`.rejects`, `expect.poll`) the test has not awaited yet. Filled
   * only when the worker turns unawaited-assertion tracking on; an assertion leaves the set when
   * the test calls `.then` on it, and what is left at the test's end is reported.
   */
  pendingAsync: Set<PendingAssertion>
  /** Whether diffs show every line (Jest's `--expand`). */
  expand?: boolean
  /** The test's full name, joined by the core policy's `nameSeparator`. */
  currentTestName?: string
  /** The test's title path: describe titles, then the test title (`TestTask.fullName`). */
  currentTestPath?: readonly string[]
  /** The running test's id; a retry or a repeat has the same one. */
  currentTestId?: string
  /** The test is `test.failing` (`test.fails`): a failed assertion is its expected outcome. */
  testFailing?: boolean
  testPath?: string
  /** The file's snapshot state (`@provino/snapshot/runtime`), set by the worker. */
  snapshotState?: unknown
  /** Keys a user or a plugin sets through `expect.setState`. */
  [key: string]: unknown
}

/**
 * The asymmetric-matcher protocol both runners share (Track 7 F3): any object with this shape
 * works inside `toEqual`, `toHaveBeenCalledWith` and the rest.
 * @public
 */
export interface AsymmetricMatcherLike {
  /** `Symbol.for('jest.asymmetricMatcher')`: pretty-format's plugin keys on it. */
  readonly $$typeof: symbol
  asymmetricMatch(other: unknown, customTesters?: readonly EqualityTester[]): boolean
  toString(): string
  toAsymmetricMatcher?(): string
  getExpectedType?(): string
}

/**
 * Builds an asymmetric matcher (`expect.any(Number)`, `expect.objectContaining({…})`).
 * @public
 */
export type AsymmetricFactory = (...sample: never[]) => AsymmetricMatcherLike

/**
 * Asymmetric factories by name.
 * @public
 */
export interface AsymmetricFactories {
  readonly [name: string]: AsymmetricFactory
}

/**
 * Where an assertion runs: plainly, or on what a promise resolved or rejected to.
 * @public
 */
export type PromiseVoice = '' | 'resolves' | 'rejects'

/**
 * What the engine knows about the call when it needs a message of its own.
 * @public
 */
export interface MatcherCall {
  readonly matcherName: string
  readonly isNot: boolean
  readonly promise: PromiseVoice
}

/**
 * An async assertion the test has not awaited (yet): what `MatcherState.pendingAsync` holds, and
 * what the dialect words its "was not awaited" error from.
 * @public
 */
export interface PendingAssertion {
  /** `settled` for `.resolves`/`.rejects`; `poll` for `expect.poll(...).matcher()`. */
  readonly kind: 'settled' | 'poll'
  /** The assertion: matcher, `.not`, and `resolves`/`rejects` (`''` for a poll). */
  readonly call: MatcherCall
  /**
   * Made where the user called the matcher, so its stack points at that line. The end-of-test
   * check sets its `message` from the table and reports it.
   */
  readonly error: Error
}

/**
 * The text the engine prints for failures that aren't a matcher's: every word comes from the
 * dialect (non-negotiable 1).
 * @public
 */
export interface ExpectMessages {
  /** `expect(a, b)` where the dialect allows one argument. */
  tooManyArguments(): string
  /** A failed matcher result without a message. */
  noMessage(): string
  /** A matcher returned something other than `{ pass, message? }`. */
  invalidResult(result: unknown): string
  /** `.resolves`/`.rejects` on a value that is not a promise (or a function returning one). */
  notAPromise(call: MatcherCall, received: unknown): string
  /** `.resolves` on a promise that rejected. */
  rejectedInsteadOfResolved(call: MatcherCall, reason: unknown): string
  /** `.rejects` on a promise that resolved. */
  resolvedInsteadOfRejected(call: MatcherCall, value: unknown): string
  /** `expect.extend` given a non-function. */
  invalidMatcher(name: string, value: unknown): string
  /** `expect.addEqualityTesters` given a non-array. */
  invalidTesters(value: unknown): string
  /** Throws when `expect.hasAssertions` gets an argument. */
  ensureNoExpected(expected: unknown, matcherName: string): void
  /** `expect.assertions(expected)` and the test made `actual` assertion calls. */
  assertionCount(expected: number, actual: number): string
  /** `expect.hasAssertions()` and the test made none. */
  noAssertions(): string
  /** `ExpectPolicy.requireAssertions` and the test made none. */
  requiredAssertions(): string
  /** An async assertion the test never awaited, when the policy fails those. */
  unawaited(pending: PendingAssertion): string
  /** An `expect.poll` stage that did not finish inside its timeout: the callback, or the matcher. */
  pollTimeout(stage: 'function' | 'assertion'): string
  /** `expect.poll(...)` read `name`, which polling cannot work with (`resolves`, `toThrow`, ...). */
  pollUnsupported(name: string): string
  /** `expect.soft` or `expect.poll` used where no test is running. */
  outsideTest(name: 'soft' | 'poll'): string
  /**
   * `expect.unreachable(message)`. Only a dialect that has `expect.unreachable` supplies this:
   * its presence is what puts the static on `expect`.
   */
  unreachable?(message: string | undefined): string
}

/**
 * A dialect's matcher table: what `ExpectPolicy.matcherTable` loads. Its matchers are built-ins
 * (flagged internal, so the engine re-anchors their stack frames like Jest does).
 * @public
 */
export interface ExpectTable {
  readonly matchers: MatcherSet
  /** Replacements used under `.resolves`/`.rejects` (Jest's `toThrow` reads a rejection). */
  readonly promiseMatchers: MatcherSet
  /** Factories on `expect` (`any`, `objectContaining`, …). */
  readonly asymmetric: AsymmetricFactories
  /** Factories on `expect.not`. */
  readonly asymmetricNot: AsymmetricFactories
  /** `this.utils` inside matchers and asymmetric matchers. */
  readonly utils: object
  readonly messages: ExpectMessages
  /**
   * The asymmetric form `expect.extend` registers for a custom matcher (`expect.toBeWithin(…)`):
   * called once per registration, it returns the builder `expect.toBeWithin` and
   * `expect.not.toBeWithin` call. Jest makes one class per registration, so instances share a
   * constructor and `toStrictEqual` treats two of them as equal.
   */
  customAsymmetric(name: string, matcher: Matcher): CustomAsymmetricBuilder
}

/**
 * Builds one instance of a custom matcher's asymmetric form: `inverse` for `expect.not`.
 * @public
 */
export type CustomAsymmetricBuilder = (
  inverse: boolean,
  sample: readonly unknown[],
) => AsymmetricMatcherLike

/**
 * The built-in matchers, by the return type `R` (`void`, or `Promise<void>` under
 * `.resolves`/`.rejects`). A dialect registers a subset at runtime; an unregistered name reads
 * `undefined`. T7.13 makes it augmentable and types `T`.
 * @public
 */
export interface Matchers<R extends void | Promise<void> = void> {
  toBe(expected: unknown): R
  toBeCloseTo(expected: number, numDigits?: number): R
  toBeDefined(): R
  toBeFalsy(): R
  toBeGreaterThan(expected: number | bigint): R
  toBeGreaterThanOrEqual(expected: number | bigint): R
  toBeInstanceOf(expected: unknown): R
  toBeLessThan(expected: number | bigint): R
  toBeLessThanOrEqual(expected: number | bigint): R
  toBeNaN(): R
  toBeNull(): R
  toBeTruthy(): R
  toBeUndefined(): R
  toContain(expected: unknown): R
  toContainEqual(expected: unknown): R
  toEqual(expected: unknown): R
  toHaveLength(expected: number): R
  toHaveProperty(path: string | readonly (string | number)[], value?: unknown): R
  toMatch(expected: string | RegExp): R
  toMatchObject(expected: object | readonly object[]): R
  toStrictEqual(expected: unknown): R
  toThrow(expected?: unknown): R
  toHaveBeenCalled(): R
  toHaveBeenCalledTimes(expected: number): R
  toHaveBeenCalledWith(...expected: readonly unknown[]): R
  toHaveBeenLastCalledWith(...expected: readonly unknown[]): R
  toHaveBeenNthCalledWith(nth: number, ...expected: readonly unknown[]): R
  toHaveReturned(): R
  toHaveReturnedTimes(expected: number): R
  toHaveReturnedWith(expected: unknown): R
  toHaveLastReturnedWith(expected: unknown): R
  toHaveNthReturnedWith(nth: number, expected: unknown): R
  /** Compares with the snapshot stored in the file's `.snap` (Track 7, T7.10). */
  toMatchSnapshot(propertiesOrHint?: object | string, hint?: string): R
  /** Compares with the snapshot written in the test's source (T7.10; the writer is T7.11). */
  toMatchInlineSnapshot(propertiesOrSnapshot?: object | string, snapshot?: string): R
  toThrowErrorMatchingSnapshot(hint?: string): R
  toThrowErrorMatchingInlineSnapshot(snapshot?: string): R
}

/**
 * What `expect(actual)` returns.
 * @public
 */
export type Assertion<R extends void | Promise<void> = void> = Matchers<R> & {
  readonly not: Matchers<R>
  readonly resolves: Matchers<Promise<void>> & { readonly not: Matchers<Promise<void>> }
  readonly rejects: Matchers<Promise<void>> & { readonly not: Matchers<Promise<void>> }
}

/**
 * What `expect.poll` passes to the function it polls.
 * @public
 */
export interface PollContext {
  /** Aborted when the poll's timeout passes, so a slow callback can stop. */
  readonly signal: AbortSignal
}

/**
 * `expect.poll`'s options. Each falls back to `ExpectPolicy.poll`.
 * @public
 */
export interface PollOptions {
  /** Milliseconds between two calls of the polled function. */
  readonly interval?: number
  /** Milliseconds after which the poll gives up. */
  readonly timeout?: number
}

/**
 * What `expect.poll(fn)` returns: matchers that retry until they pass and return a promise to
 * await. No `resolves`/`rejects`, and no matcher that throws or snapshots.
 * @public
 */
export type PollAssertion = Matchers<Promise<void>> & {
  readonly not: Matchers<Promise<void>>
}

/**
 * The asymmetric factories both runners have, inverted on `expect.not`.
 * @public
 */
export interface InvertibleAsymmetric {
  arrayContaining(sample: readonly unknown[]): AsymmetricMatcherLike
  closeTo(expected: number, numDigits?: number): AsymmetricMatcherLike
  objectContaining(sample: object): AsymmetricMatcherLike
  stringContaining(expected: string): AsymmetricMatcherLike
  stringMatching(expected: string | RegExp): AsymmetricMatcherLike
}

/**
 * The `expect` function and its statics. Every factory in the table is on it by name; the
 * shared ones are typed here, and a dialect-only one (Jest's `arrayOf`) reads as `unknown`.
 * @public
 */
export interface ExpectStatic extends InvertibleAsymmetric {
  (actual: unknown): Assertion
  readonly not: InvertibleAsymmetric & { readonly [asymmetric: string]: unknown }
  any(type: unknown): AsymmetricMatcherLike
  anything(): AsymmetricMatcherLike
  extend(matchers: MatcherSet): void
  addEqualityTesters(testers: readonly EqualityTester[]): void
  assertions(expected: number): void
  hasAssertions(): void
  /** Present when `ExpectPolicy.soft` is on: a failure is recorded and the test goes on. */
  soft?: (actual: unknown) => Assertion
  /** Present when `ExpectPolicy.poll.enabled` is on. */
  poll?: (fn: (context: PollContext) => unknown, options?: PollOptions) => PollAssertion
  /** Present when the dialect's table words it (`ExpectMessages.unreachable`). */
  unreachable?: (message?: string) => never
  getState(): MatcherState
  setState(state: Partial<MatcherState>): void
  /** Adds a snapshot serializer for the running file, ahead of the others. */
  addSnapshotSerializer(plugin: SnapshotPlugin): void
  readonly [asymmetric: string]: unknown
}
