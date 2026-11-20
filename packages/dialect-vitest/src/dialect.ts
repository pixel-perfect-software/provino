// The Vitest 5.0 dialect value (T1.8's Vitest half, T11.1, T11.2). Policy values, the names of the
// globals it injects (`/runtime`'s `vitestGlobals`: `vi` and the served `vitest` modules), the
// environment resolver and its type entries. The config reader is `/node`'s `vitestNodeDialect`;
// the command line comes with B25g, so `provino vitest` is refused until then.
//
// Every value matches Vitest 5.0.5. The evidence for each one is in `@provino/harness`'s
// `src/policy-truth/claims/` (T1.7, CLAUDE.md non-negotiable 2): a golden recorded from the real
// Vitest (or, for a value no run shows, its pinned code called inside a recorded fixture, D27), a
// corpus check whose flipped value fails, our own key with its test, or a `pending` entry naming
// the bundle that builds it. `policy-truth.test.ts` fails when a value and its evidence disagree.
// A comment here says why a value is what it is where that isn't obvious.
import { defineDialect, moduleRef } from '@provino/policy'
import type {
  Dialect,
  EnvironmentConditions,
  EnvironmentResolver,
  FormatDefinitionError,
  FormatEachTitle,
  GlobalsFactory,
  MatcherTableFactory,
  ModuleScopeFactory,
  PolicyOverrides,
  ShapeTestError,
  SnapshotPrinterFactory,
} from '@provino/types'
import { VITEST_EACH_TITLE_TRUNCATE } from './each/title-truncate.ts'
import { vitestHoistPolicy } from './hoist-policy.ts'
import { vitestMockPolicy, vitestModulePolicy } from './mock-policy.ts'

/** Vitest's `defaultInclude`: what its `test.include` is when nothing sets it. */
export const defaultInclude: string[] = ['**/*.{test,spec}.?(c|m)[jt]s?(x)']

/** Vitest's `defaultExclude`: what its `test.exclude` is when nothing sets it. */
export const defaultExclude: string[] = ['**/node_modules/**', '**/.git/**']

/**
 * Vitest 5.0's policy (with `sequence.hooks: 'stack'`, its default), layered over the neutral
 * policy by `resolvePolicy`. This is `vitestDialect.policy`, typed as the overrides it is.
 * @public
 */
export const vitestPolicy: PolicyOverrides = {
  core: {
    hookOrder: {
      beforeAll: 'declaration',
      beforeEach: 'declaration',
      afterEach: 'reverse',
      afterAll: 'reverse',
    },
    eachHooksForConcurrent: true,
    firstArg: 'context',
    allowGeneratorFns: false,
    timeouts: { test: 5000, hook: 10000, teardown: 10000, catchSyncOverrun: true, zero: 'none' },
    nameSeparator: ' > ',
    testNamePatternFlags: '',
    missingTestFn: 'todo',
    asyncDescribe: 'await',
    nonPromiseReturn: 'ignore',
    // Vitest's `formatTitle` and `format` (`src/each/`), exported by `/runtime`. It cuts each value to
    // `eachTitleTruncate` characters: the formatter reads no policy, so it holds that 40 itself.
    formatEachTitle: moduleRef<FormatEachTitle>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'formatEachTitle',
    ),
    eachTitleTruncate: VITEST_EACH_TITLE_TRUNCATE,
    // `functionCondition`: Vitest 5.0.5 never calls a function `retry.condition` and retries every
    // failure (runtime corpus `retry-condition-function` agrees). Honouring it here could turn a
    // green suite red, so this dialect keeps the outcome and warns (D7); neutral calls it.
    // `functionConditionWarning` is Provino's own text (core names the test before it).
    retry: {
      timing: 'immediate',
      keepEarlierErrors: true,
      functionCondition: 'ignore-warn',
      functionConditionWarning:
        'Vitest 5.0 never calls a function condition and retries every failure, and so does this ' +
        'mode, so the outcome of a suite that passes there does not change. Pass a RegExp (tested ' +
        'against the error message) to limit the retries, or use the neutral mode, which calls the ' +
        'function.',
    },
    allowOnly: 'not-in-ci',
    maxConcurrency: 5,
    unawaitedAsyncAssertion: 'fail',
    hookReturnsCleanup: true,
    // Vitest's `globals` option, off by default.
    injectGlobals: false,
    // With `globals: true`, setup files run after the globals are in (`core-globals-at-setup`).
    globalsBeforeSetupFiles: 'all',
    // The context is a function; calling it (a stray `done()`) throws this (`runtime/done-callback`,
    // `runtime/context-shape`, Vitest 5.0.5 `runner/src/context.ts`).
    doneDeprecatedMessage: 'done() callback is deprecated, use promise instead',
    collect: {
      describeBody: 'deferred',
      describeReturnValue: 'ignore',
      lateRegistration: 'warn-drop',
      emptyDescribe: 'fail-suite',
      nestedInTest: 'throw',
      todoWithFn: 'todo',
      // Vitest drops an incomplete trailing row.
      eachTableError: 'lenient',
    },
    hooks: {
      afterError: 'abort-chain',
      beforeAllError: 'skip-subtree',
      nestedHooksAfterBeforeAllError: 'skip',
      afterAllError: 'fail-suite',
      timeoutCountsTestTimeout: false,
      skippedBlock: 'none',
    },
    concurrency: { grouping: 'consecutive', limitHooks: true },
    // Vitest checks `expect.hasAssertions` only on a test that passed (`policy/core-outcomes`).
    // processListeners: Vitest's worker keeps its listeners beside the process's own (not recorded,
    // T11.16), and it has no `waitForUnhandledRejections`.
    errors: {
      lateErrors: 'report-run',
      processListeners: 'alongside',
      waitForUnhandledRejections: false,
      hasAssertionsWhenFailed: 'skip',
    },
    focus: { scope: 'suite', insideSkip: 'skipped' },
    status: { todoUnderSkip: 'todo', expectFail: 'attempt' },
    locationFrame: 'test-file',
    // Each error a failed test ended with gets the `diff` Vitest's runner adds (`processError`),
    // which core keeps as the serialized error's `diff` (`expect/messages/*`'s Vitest goldens).
    shapeTestError: moduleRef<ShapeTestError>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestShapeTestError',
    ),
    // Vitest's `test` has `extend` and `override` (`runtime/fixture-extend-api`), and its fixture
    // errors are worded as Vitest words them (`runtime/fixture-parse-error`, T5.9).
    definitions: {
      extendApi: 'expose',
      messages: moduleRef<FormatDefinitionError>(
        import.meta.resolve('@provino/dialect-vitest/runtime'),
        'vitestFixtureMessages',
      ),
      // A plain `beforeAll(({ key }) => …)` fails as Vitest's `validateSuiteHook` fails it
      // (runtime corpus `fixture-suite-hook-access` agrees).
      plainSuiteHook: 'refuse-fixtures',
    },
  },
  lazy: { readInBeforeAll: 'error' },
  mock: vitestMockPolicy,
  timers: {
    toFakeDefault: 'all-but-microtasks',
    loopLimit: 10000,
    fakeTemporal: true,
    legacyAvailable: false,
    enableGlobally: false,
    optionNames: 'to-fake',
    notFaked: 'throw',
    setSystemTimeWithoutFakes: 'fake-date-only',
    advanceToNextTimerHonorsSteps: false,
    // Every `vi` timer member returns `vi`, an async one resolving to it.
    facadeReturns: 'all',
    // Vitest 5.0.5 `integrations/mock/timers.ts` `_checkFakeTimers`.
    messages: {
      notFaked:
        'A function to advance timers was called but the timers APIs are not mocked. Call `vi.useFakeTimers()` in the test file first.',
    },
  },
  module: vitestModulePolicy,
  snapshot: {
    header: '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html',
    keyJoin: ' > ',
    hintJoin: ' > ',
    dirName: '__snapshots__',
    extension: '.snap',
    format: {
      escapeString: false,
      printBasicPrototype: false,
      maxOutputLength: 2 ** 27,
      extra: {},
    },
    obsolete: { failLocal: false, failCI: true },
    ciUpdate: 'none',
    updateEnvVar: 'UPDATE_SNAPSHOT',
    throwErrorBody: 'error',
    // D61: a mismatch throws at the call (`snapshot/mismatch-throws-at-call`).
    mismatch: 'throw',
    inline: { indent: 'call', formatter: 'none', writer: null, prettierPath: null },
    // Provino's own key (B23d B1): Vitest's `resolveSnapshotPath` is T11.16's.
    resolverFactory: null,
    // Provino's own key (B23e): what Vitest's matchers read of `this.snapshotState` is T7.6's.
    contextView: null,
    // Provino's own key (T7.10): `@vitest/pretty-format` 5.0, vendored, and its words.
    printer: moduleRef<SnapshotPrinterFactory>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestSnapshotPrinter',
    ),
  },
  expect: {
    matcherNamespace: 'vitest',
    // Not recorded yet (T11.16): the neutral `drop` stands.
    outsideTestCounts: 'drop',
    // Vitest counts each `expect()` call (`expect/policies/assertions-per-expect`).
    assertionCalls: 'per-expect-call',
    pollFailsOnTimeout: true,
    diffContextLines: 5,
    valueFormatter: 'pretty-format',
    errorShape: 'assertion-error',
    // `.resolves`/`.rejects` check the value as they are read (`expect/messages/promises`).
    settlementCheck: 'at-read',
    // `expect(value, message)` takes a message (`expect/messages/extend-and-misuse`).
    messageArgument: true,
    // `@vitest/expect` 5.0.5's matchers, vendored, exported by `/runtime` (T7.6, D170).
    matcherTable: moduleRef<MatcherTableFactory>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestExpectTable',
    ),
    equality: { errors: 'assert', invalidDate: 'equal' },
    soft: true,
    poll: { enabled: true, intervalMs: 50, timeoutMs: 1000 },
    requireAssertions: false,
    expand: false,
  },
  orchestrator: {
    include: defaultInclude,
    exclude: defaultExclude,
    bail: { checkAfter: 'test' },
    watchDefault: 'tty-not-ci',
    watch: { initialRun: 'all' },
    // Vitest resolves server side whatever the environment: `node`, jsdom included
    // (`env/conditions-vitest-jsdom`).
    environmentConditions: moduleRef<EnvironmentConditions>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestEnvironmentConditions',
    ),
    // Vitest's `include` is relative to the root (`policy/orchestrator-match-path`).
    globMatchesOn: 'root-relative-path',
    // Vitest's rule is not recorded yet (T11.16): a file where nothing ran is skipped.
    todoOnlyFile: 'skip',
    // Not recorded yet (T11.16): read from Vitest 5.0.5's source. `runFiles` fails a file with no
    // task unless `passWithNoTests` is set (`runner/run.ts`: "No test suite found in file"), and
    // `runSuite` fails a `describe` with no test the same way ("No test found in suite"), which this
    // file-level key doesn't see. T11.16's recording decides both.
    noTestsFile: 'fail-unless-pass-with-no-tests',
    // Not recorded yet (T11.16): no call site is kept.
    consoleOrigin: 'none',
    // Vitest 5.0.5's node environment (`integrations/env/node.ts`) builds no global, so a test sees
    // its worker's own `process`; not recorded yet (T11.16).
    processObject: 'shared',
    passWithNoTests: false,
    // `usage` is `cli/unknown-flag`: cac throws on an unknown option and the process exits 1.
    exitCodes: { failure: 1, noTests: 1, unhandled: 1, usage: 1 },
    unhandledErrors: 'fail-run',
    coverageProvider: 'v8',
    coverageReporters: ['text', 'html', 'clover', 'json'],
    slowTestThresholdMs: 300,
    // Ours (D6 for Jest; Vitest isolates each file in its own module graph, as `registry` does).
    // A DOM environment too: Vitest 5.0.5's `jsdom` and `happy-dom` set up on the worker's own
    // global (`populateGlobal`), and only a `vm*` pool gives them a context of their own, so they
    // stay on `registry` where the neutral value puts them on `realm`.
    isolationDefault: {
      default: 'registry',
      byEnvironment: { jsdom: 'registry', 'happy-dom': 'registry' },
    },
    envDefault: 'node',
    environmentPragmas: ['vitest-environment', 'jest-environment'],
    pool: { default: 'forks' },
    // Vitest 5.0.5 forked a single file (`policy/orchestrator-run-in-band`).
    inBand: { single: false, fastFileCount: 0, slowMs: 0 },
    // Vitest 5.0.5's `BaseSequencer.shard` hashes each path with its leading `/`
    // (`cli/vitest-shard-1-of-3` to `3-of-3`).
    shard: { fallback: 'rooted-sha1-slice' },
    sequence: { unknownFirst: true },
    globalSetup: {
      signature: 'project-with-teardown',
      // Vitest closes the projects last to first (core.ts); a fixture waits for T11.16
      teardownOrder: 'reverse',
      // `failure` stays the neutral behaviour: Vitest rethrows the setup's own error, which a
      // recording waits for T11.16 to show.
    },
  },
  report: {
    displaySeparator: ' > ',
    defaultReporters: ['default'],
    failureTitleBullet: null,
    // Not recorded for Vitest yet (T11.16); the neutral reporters list a file's tests on request only.
    listTestsForSingleFile: false,
    resultStatusSkipped: 'skipped',
  },
  coverage: {
    thresholdGrouping: 'all-files',
    globThresholdScope: 'aggregate',
    includeUntestedByDefault: true,
    reportsDirectory: './coverage',
    // Not recorded for Vitest yet (B25); the neutral values stand.
    v8Conversion: 'ast',
    v8HitCounts: false,
    v8Hashbang: 'kept',
    istanbulVariable: '__coverage__',
    thresholdMessages: {
      belowMinimum:
        'Coverage for {metric} ({actual}%) does not meet "{name}" threshold ({threshold}%)',
      aboveMaximumUncovered:
        'Uncovered count for {metric} ({actual}) exceeds {name} threshold ({threshold})',
      notFound: 'Coverage data for {path} was not found.',
    },
  },
}

/**
 * The modules the Vitest dialect serves itself (`moduleScope.modules`, U9's Vitest half): Vitest
 * 5.0.5's own `vitest`, `@vitest/expect`, `@vitest/spy` and `vitest/runtime` (`populateGlobal`).
 */
const VITEST_SERVED_MODULES: readonly string[] = [
  'vitest',
  '@vitest/expect',
  '@vitest/spy',
  'vitest/runtime',
]

/**
 * The globals Vitest 5.0 injects with `globals: true` (`vitest/src/constants.ts`'s `globalApis`,
 * which `integrations/globals.ts` installs), sorted. `core-globals-at-setup` records them.
 */
const VITEST_GLOBAL_NAMES: readonly string[] = [
  'afterAll',
  'afterEach',
  'aroundAll',
  'aroundEach',
  'assert',
  'assertType',
  'beforeAll',
  'beforeEach',
  'chai',
  'describe',
  'expect',
  'expectTypeOf',
  'it',
  'onTestFailed',
  'onTestFinished',
  'suite',
  'test',
  'vi',
  'vitest',
]

/**
 * What a project config may put under `vitest`: nothing yet, so only an empty object. Vitest's own
 * options arrive with the config reader (T11.15, Phase 2).
 * @public
 */
export type VitestDialectOptions = Record<string, never>

// Registers the dialect's name, as `@provino/dialect-jest` does for `jest`.
declare module '@provino/types' {
  interface DialectRegistry {
    vitest: VitestDialectOptions
  }
}

/**
 * The Vitest 5.0 dialect: its policy values, the globals it injects (`vi` and the served `vitest`
 * modules), its environment resolver and its type entries. The config reader is `/node`'s
 * `vitestNodeDialect`; the command line comes with B25g.
 * @public
 */
export const vitestDialect: Dialect<'vitest'> = defineDialect({
  name: 'vitest',
  version: '5.0',
  policy: vitestPolicy,
  globals: {
    factory: moduleRef<GlobalsFactory>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestGlobals',
    ),
    names: VITEST_GLOBAL_NAMES,
  },
  loader: { hoist: vitestHoistPolicy },
  moduleScope: {
    // Each module that names `vi` gets its own, which knows its caller: Vitest has one object and
    // finds the caller from the stack (`getImporter`). The global `vitest` (the same object) is no
    // binding, since the scope's keys are also the served specifiers and `vitest` is one: a module
    // that calls `vitest.mock` through the global resolves from the root (a limit). The four
    // modules are the runner's own (U9), answered before the resolver, the mapper and any mock.
    names: ['vi'],
    modules: VITEST_SERVED_MODULES,
    factory: moduleRef<ModuleScopeFactory>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestModuleScope',
    ),
  },
  // A test file's `@vitest-environment` or `@jest-environment` docblock (T8.6), resolved in the
  // worker from the project's root (`env/vitest-docblock`, `env/vitest-options`).
  environmentResolver: moduleRef<EnvironmentResolver>(
    import.meta.resolve('@provino/dialect-vitest/runtime'),
    'vitestEnvironmentFor',
  ),
  typeEntries: ['@provino/dialect-vitest/runtime'],
})
