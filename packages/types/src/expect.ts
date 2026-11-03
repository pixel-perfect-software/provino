// Track 7 §Types: the contract between the neutral `expect` engine (`@provino/expect`) and a
// dialect's matcher table, plus the first cut of the matcher registry. The engine owns the front
// end, the per-test state and the global slot; the table owns every matcher, every asymmetric
// matcher, `this.utils` and every word the engine prints. Augmentation, the context supertype
// and the Jest/Vitest bridges are T7.13's (Phase 2).

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
  /** Failures held back by `dontThrow()` (snapshot matchers) until the test ends. */
  suppressedErrors: Error[]
  /** Whether diffs show every line (Jest's `--expand`). */
  expand?: boolean
  /** The test's full name, joined by the core policy's `nameSeparator`. */
  currentTestName?: string
  testPath?: string
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
  getState(): MatcherState
  setState(state: Partial<MatcherState>): void
  readonly [asymmetric: string]: unknown
}
