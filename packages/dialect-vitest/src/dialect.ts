// The Vitest 5.0 dialect value (T1.8's Vitest half, T11.1, T11.2). Policy values, the names of the
// globals it injects and its type entries; no config reader, flags or facades yet (T11.15, T11.16,
// Phase 2), so `provino` doesn't list it among its built-in dialects and no run reaches the stubs.
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
  FormatEachTitle,
  GlobalsFactory,
  PolicyOverrides,
  SnapshotPrinterFactory,
} from '@provino/types'
import { VITEST_EACH_TITLE_TRUNCATE } from './each/title-truncate.ts'
import { vitestHoistPolicy } from './hoist-policy.ts'
import { vitestMockPolicy, vitestModulePolicy } from './mock-policy.ts'

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
    errors: { lateErrors: 'report-run', hasAssertionsWhenFailed: 'skip' },
    focus: { scope: 'suite', insideSkip: 'skipped' },
    status: { todoUnderSkip: 'todo', expectFail: 'attempt' },
    locationFrame: 'test-file',
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
    inline: { indent: 'call', formatter: 'none', writer: null, prettierPath: null },
    // Provino's own key (B23d B1): Vitest's `resolveSnapshotPath` is T11.16's.
    resolverFactory: null,
    // Provino's own key (T7.10): `@vitest/pretty-format` 5.0, vendored, and its words.
    printer: moduleRef<SnapshotPrinterFactory>(
      import.meta.resolve('@provino/dialect-vitest/runtime'),
      'vitestSnapshotPrinter',
    ),
  },
  expect: {
    matcherNamespace: 'vitest',
    pollFailsOnTimeout: true,
    diffContextLines: 5,
    valueFormatter: 'pretty-format',
    errorShape: 'assertion-error',
    equality: { errors: 'assert', invalidDate: 'equal' },
    soft: true,
    poll: { enabled: true, intervalMs: 50, timeoutMs: 1000 },
    requireAssertions: false,
    expand: false,
  },
  orchestrator: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/.git/**'],
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
    isolationDefault: { default: 'registry' },
    envDefault: 'node',
    environmentPragmas: ['vitest-environment', 'jest-environment'],
    pool: { default: 'forks' },
    runInBand: { auto: false },
    // Vitest 5.0.5's `BaseSequencer.shard` (read from its source, not recorded: T11.16).
    shard: { fallback: 'sha1-slice' },
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
 * The Vitest 5.0 dialect: its policy values, the globals it injects and its type entries. The
 * config reader, the CLI flags and the `vitest` facade come with T11.15 and T11.16 (Phase 2); until
 * then the globals factory is a stub that throws.
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
  typeEntries: ['@provino/dialect-vitest/runtime'],
})
