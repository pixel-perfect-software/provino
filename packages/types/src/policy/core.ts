import type { Behaviour } from './behaviour.ts'

/**
 * The four hook kinds.
 * @public
 */
export type HookKind = 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll'

/**
 * How hooks of one kind run: in declaration order, reversed (a stack), or all at once.
 * @public
 */
export type HookOrder = 'declaration' | 'reverse' | 'parallel'

/**
 * Formats a `test.each`/`describe.each` title from its template and row.
 * @public
 */
export type FormatEachTitle = (
  template: string,
  row: readonly unknown[] | Readonly<Record<string, unknown>>,
  index: number,
) => string

/**
 * The escape hatch for an ordering no `HookOrder` describes: returns the hooks of one kind in
 * the order to run them.
 * @public
 */
export type OrderHooks = <Hook>(hooks: readonly Hook[], kind: HookKind) => readonly Hook[]

/**
 * The `core` slice, read by `@provino/core` (Track 5): collection, hooks, timeouts, naming,
 * retries and focus.
 *
 * Each key's comment gives the Jest 30.5 and Vitest 5.0 values from the research. None is
 * checked against the real runners yet; B14 (T1.7) records ground truth for every one.
 * @public
 */
export interface CorePolicy {
  /**
   * Order of each hook kind. Also covers Track 5's `hooks.afterOrder`/`hooks.parallel`, Track 11's
   * `hookOrder` and Track 12's `hooks.afterOrder`.
   * Jest: all `declaration`. Vitest: before `declaration`, after `reverse` (`sequence.hooks: 'stack'`).
   * unverified: track-01 L180, track-05 L313
   */
  readonly hookOrder: { readonly [K in HookKind]: HookOrder }
  /**
   * Whether `beforeEach`/`afterEach` run around `test.concurrent` tests. Also Track 12's
   * `concurrent.eachHooks`. Jest: `false`. Vitest: `true`.
   * unverified: track-01 L181, track-05 L315, track-12 L528
   */
  readonly eachHooksForConcurrent: boolean
  /**
   * What a test function's first parameter is: a `done` callback when the function declares one,
   * or a test context. Also Track 5's `firstArgument` and Track 11's `doneCallback`.
   * Jest: `done-if-arity`. Vitest: `context`.
   * unverified: track-01 L182, track-05 L316
   */
  readonly firstArg: 'done-if-arity' | 'context'
  /** Whether generator functions are accepted as tests. Jest: `true`. Vitest: `false`. unverified: track-01 L183 */
  readonly allowGeneratorFns: boolean
  /**
   * Default timeouts in ms, and whether a synchronous overrun of the test timeout fails the test.
   * Jest: test 5000, hook 5000, catchSyncOverrun `false`; Jest has no teardown timeout, so B14
   * picks the value that reproduces its behaviour.
   * Vitest: 5000 / 10000 / 10000, catchSyncOverrun `true`.
   * unverified: track-01 L184, track-05 L315, track-05 L318, track-11 L514
   */
  readonly timeouts: {
    readonly test: number
    readonly hook: number
    readonly teardown: number
    readonly catchSyncOverrun: boolean
  }
  /**
   * Joins describe and test names into the full name used for filtering, `currentTestName` and
   * reports. Also Track 5's `titles.nameJoiner`, Track 7's `testName.join`, Track 9's
   * `testNamePattern.separator` and Track 11's `testNameJoin`. Jest: `' '`. Vitest: `' > '`.
   * unverified: track-01 L185, track-05 L321
   */
  readonly nameSeparator: string
  /** RegExp flags for `-t`/`testNamePattern`. Jest: `'i'`. Vitest: `''`. unverified: track-01 L186 */
  readonly testNamePatternFlags: string
  /**
   * A test declared without a function. Also Track 5's `collect.missingTestFn`.
   * Jest: `throw`. Vitest: `todo`. unverified: track-01 L187, track-05 L312
   */
  readonly missingTestFn: 'throw' | 'todo'
  /**
   * An `async` describe callback. Also Track 5's `collect.asyncDescribe`.
   * Jest: `throw`. Vitest: `await`. unverified: track-01 L188, track-05 L311
   */
  readonly asyncDescribe: 'throw' | 'await'
  /** A test function that returns a non-promise value. Jest: `fail`. Vitest: `ignore`. unverified: track-01 L189 */
  readonly nonPromiseReturn: 'fail' | 'ignore'
  /**
   * Formats `.each` titles. Also Track 5's `titles.format`.
   * Jest: jest-each (`%p` pretty, `%#`, `$var`). Vitest: `%#`/`%$`, `$var` unquoted, `%p` literal.
   * unverified: track-01 L190, track-05 L441
   */
  readonly formatEachTitle: Behaviour<FormatEachTitle>
  /** Maximum length of an interpolated `.each` value, or `null` for none. Jest: `null`. Vitest: 40. unverified: track-01 L191 */
  readonly eachTitleTruncate: number | null
  /**
   * When a failed test retries, whether earlier attempts' errors are logged, and whether they are
   * kept on the result. Track 5 adds `keepEarlierErrors`.
   * Jest: `deferred` (to the end of the suite; `immediate` with `retryImmediately`). Vitest: `immediate`.
   * unverified: track-01 L192, track-05 L319
   */
  readonly retry: {
    readonly timing: 'deferred' | 'immediate'
    readonly logErrorsBeforeRetry: boolean
    readonly keepEarlierErrors: boolean
  }
  /**
   * Whether `.only` is allowed. Also Track 5's `only.allowOnly`.
   * Jest: `always`. Vitest: `not-in-ci`. unverified: track-01 L193
   */
  readonly allowOnly: 'always' | 'not-in-ci'
  /** Default `maxConcurrency`. Jest: 5. Vitest: 5. unverified: track-01 L194, track-05 L317 */
  readonly maxConcurrency: number
  /**
   * An unawaited async assertion (`expect(p).resolves…`) still pending at test end. Track 7 lists
   * it as `expect.unawaitedAsyncAssertion`; it stays here because the executor decides the
   * outcome. Jest: `ignore`. Vitest: `fail`. unverified: track-01 L195, track-07 L462
   */
  readonly unawaitedAsyncAssertion: 'ignore' | 'fail'
  /**
   * Whether a function returned from a hook runs as its teardown. Also Track 5's
   * `hooks.beforeReturn`. Jest: `false`. Vitest: `true`. unverified: track-01 L196, track-05 L314
   */
  readonly hookReturnsCleanup: boolean
  /** Whether the dialect's globals are injected before setup files run. Jest: `true`. Vitest: config `globals` (default `false`). unverified: track-11 L521 */
  readonly injectGlobals: boolean
  /** Warning printed when a test uses a `done` callback, or `null` for none. Values: not in the research; B14 records them. */
  readonly doneDeprecatedMessage: string | null
  /** Collection (Track 5 `collect.*`). */
  readonly collect: {
    /** When describe bodies run. Jest: `immediate`. Vitest: `deferred`. unverified: track-05 L311 */
    readonly describeBody: 'immediate' | 'deferred'
    /** A describe callback that returns a value. Values: not in the research's table; B14 records them. */
    readonly describeReturnValue: 'error' | 'ignore'
    /** A test or hook registered after collection. Jest: `fail-file`. Vitest: `warn-drop`. unverified: track-05 L312 */
    readonly lateRegistration: 'fail-file' | 'warn-drop'
    /** A describe with no tests. Jest: `fail-file-if-hooks`. Vitest: `fail-suite`. unverified: track-05 L312 */
    readonly emptyDescribe: 'fail-file-if-hooks' | 'fail-suite' | 'allow'
  }
  /** Hook failure and edge cases (Track 5 `hooks.*`, Track 12 fuzzing). */
  readonly hooks: {
    /** After a failing `after*` hook. Jest: `continue`. Vitest: `abort-chain`. unverified: track-05 L314 */
    readonly afterError: 'continue' | 'abort-chain'
    /**
     * A failing `beforeAll`. Also Track 12's `hooks.beforeAllFailure` (`failTests`/`skipTests`).
     * Jest: `attach-to-tests`. Vitest: `skip-subtree`. unverified: track-05 L314, track-12 L528
     */
    readonly beforeAllError: 'attach-to-tests' | 'skip-subtree'
    /** Whether nested hooks still run after a `beforeAll` failure (Track 12). Values: B14 records them. unverified: track-12 L528 */
    readonly nestedHooksAfterBeforeAllError: 'run' | 'skip'
    /** A failing `afterAll`. Jest: `unhandled`. Vitest: `fail-suite`. unverified: track-05 L314 */
    readonly afterAllError: 'unhandled' | 'fail-suite'
    /** Whether hook time counts against the test's timeout. Values: not in the research's table; B14 records them. */
    readonly timeoutCountsTestTimeout: boolean
    /** Whether `beforeAll` runs for a block whose tests are all skipped. Jest: `run-before-all`. Vitest: `none`. unverified: track-12 L528 */
    readonly skippedBlock: 'run-before-all' | 'none'
  }
  /** Concurrent tests (Track 5 `concurrency.*`). */
  readonly concurrency: {
    /** How `test.concurrent` tests are grouped. Jest: `hoist-to-first`. Vitest: `consecutive`. unverified: track-05 L317 */
    readonly grouping: 'hoist-to-first' | 'consecutive'
    /** Whether `maxConcurrency` also limits hooks. Jest: `false`. Vitest: `true`. unverified: track-05 L317 */
    readonly limitHooks: boolean
  }
  /** Error attribution (Track 5 `errors.*`). */
  readonly errors: {
    /** An error after its test ended. Jest: `fail-owner`. Vitest: `report-run`. unverified: track-05 L320 */
    readonly lateErrors: 'fail-owner' | 'report-run'
    /** Whether `expect.hasAssertions` is checked on a test that already failed. Jest: `skip`. Vitest: `check`. unverified: track-05 L320 */
    readonly hasAssertionsWhenFailed: 'skip' | 'check'
  }
  /** `.only` scoping (Track 12 `focus.*`). */
  readonly focus: {
    /** What `.only` narrows. Jest: `file`. Vitest: `suite`. unverified: track-12 L528 */
    readonly scope: 'file' | 'suite'
    /** A `.only` inside a skipped describe. Jest: `runs`. Vitest: `skipped`. unverified: track-12 L528 */
    readonly insideSkip: 'runs' | 'skipped'
  }
  /** Result status (Track 12 `status.*`). */
  readonly status: {
    /** A `todo` test under a skipped describe. Jest: `skipped`. Vitest: `todo`. unverified: track-12 L528 */
    readonly todoUnderSkip: 'skipped' | 'todo'
  }
  /** Custom hook ordering, or `null` to use `hookOrder` (Track 5's optional escape hatch). */
  readonly orderHooks: Behaviour<OrderHooks> | null
}
