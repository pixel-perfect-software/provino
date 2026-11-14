import type {
  EnvironmentConditions,
  FormatEachTitle,
  FormatValue,
  GlobalSetupFailure,
  Policy,
  SnapshotKey,
} from '@provino/types'
import { deepFreeze } from './internal/objects.ts'
import { moduleRef } from './module-ref.ts'

/**
 * Where the neutral behaviours live, as an absolute `file:` URL (D21: a ref that crosses to a worker
 * is absolute, so nothing depends on where the worker resolves from). The package names itself
 * through its own `exports`, which works in source (`--conditions=provino-source`) and once built.
 */
const BEHAVIOURS: string = import.meta.resolve('@provino/policy/behaviours')

/**
 * The neutral dialect's policy: what Provino does with no dialect, and the base every layer
 * overrides. These are Provino's own choices, not Jest's or Vitest's ("better by default",
 * DECISIONS D7): mistakes fail loudly, state doesn't leak between tests, setup and teardown are
 * symmetric, and ESM semantics come first. `neutral.test.ts` pins the choices that matter most;
 * a comment beside a value gives its reason where it isn't obvious.
 * @public
 */
export const neutralPolicy: Policy = deepFreeze({
  core: {
    // Teardown unwinds setup, like a stack.
    hookOrder: {
      beforeAll: 'declaration',
      beforeEach: 'declaration',
      afterEach: 'reverse',
      afterAll: 'reverse',
    },
    eachHooksForConcurrent: true,
    firstArg: 'context',
    // A generator test whose body never runs would pass silently.
    allowGeneratorFns: false,
    // 0 conventionally means "no timeout".
    timeouts: { test: 5000, hook: 10000, teardown: 10000, catchSyncOverrun: true, zero: 'none' },
    nameSeparator: ' > ',
    testNamePatternFlags: '',
    // RSpec-style: an example without a body is pending.
    missingTestFn: 'todo',
    // Collection stays synchronous and deterministic.
    asyncDescribe: 'throw',
    nonPromiseReturn: 'fail',
    formatEachTitle: moduleRef<FormatEachTitle>(BEHAVIOURS, 'formatEachTitle'),
    formatValue: moduleRef<FormatValue>(BEHAVIOURS, 'formatValue'),
    eachTitleTruncate: null,
    // A function `retry.condition` is called: a condition the user wrote is never silently dropped.
    retry: {
      timing: 'immediate',
      keepEarlierErrors: true,
      functionCondition: 'call',
      functionConditionWarning:
        'every failure is retried instead. Pass a RegExp (tested against the error message) to limit the retries.',
    },
    // A `.only` committed by mistake must not shrink a CI run.
    allowOnly: 'not-in-ci',
    maxConcurrency: 5,
    // An unawaited assertion would otherwise pass silently.
    unawaitedAsyncAssertion: 'fail',
    hookReturnsCleanup: true,
    // The neutral API is imported, not global.
    injectGlobals: false,
    // A setup file sees what the test file sees.
    globalsBeforeSetupFiles: 'all',
    doneDeprecatedMessage: null,
    collect: {
      describeBody: 'immediate',
      describeReturnValue: 'error',
      lateRegistration: 'fail-file',
      emptyDescribe: 'allow',
      // A misplaced registration stops where it was made; the test fails either way.
      nestedInTest: 'throw',
      // A todo's body is kept for later, as RSpec's pending examples are.
      todoWithFn: 'todo',
      // A broken table fails loudly, but only its own test.
      eachTableError: 'failing-test',
    },
    hooks: {
      // Run as much teardown as possible.
      afterError: 'continue',
      // Every affected test reports the failure; nothing is skipped silently.
      beforeAllError: 'attach-to-tests',
      nestedHooksAfterBeforeAllError: 'skip',
      afterAllError: 'fail-suite',
      timeoutCountsTestTimeout: false,
      skippedBlock: 'none',
    },
    concurrency: { grouping: 'consecutive', limitHooks: true },
    errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' },
    // An explicit skip wins over `.only`.
    focus: { scope: 'file', insideSkip: 'skipped' },
    // `.failing` asserts the body fails; a hook error is still a failure.
    status: { todoUnderSkip: 'todo', expectFail: 'body' },
    // A test a helper registers points at the line in the test file.
    locationFrame: 'test-file',
    orderHooks: null,
  },
  lazy: { readInBeforeAll: 'error' },
  mock: {
    resetTo: 'original-impl',
    defaultName: 'fn()',
    // Calls, spies and stubs never leak into the next test.
    between: {
      order: ['restore', 'reset', 'clear', 'unstubEnvs', 'unstubGlobals'],
      clear: true,
      reset: false,
      restore: true,
      unstubEnvs: true,
      unstubGlobals: true,
    },
    classMockPrototype: 'chain-to-impl',
    spyNameFromMethod: true,
    functionName: 'impl-or-Mock',
    newCall: 'construct',
    valueShorthandsThrowOnNew: true,
    fnOfMockReturnsSame: true,
    copyStaticProps: true,
    settledResults: true,
    lastCallKey: 'always',
    clearReplacesStateObject: false,
    mockPropertyWritable: false,
    withImplementationReturnsMock: true,
    getImplPrefersOnce: true,
    spyReportsBridgeImpl: false,
    isMockAcceptsObjects: false,
    spyInstall: 'define',
    messages: {},
  },
  timers: {
    // Faking microtasks breaks promises.
    toFakeDefault: 'all-but-microtasks',
    loopLimit: 10000,
    fakeTemporal: true,
    legacyAvailable: false,
    enableGlobally: false,
    optionNames: 'to-fake',
    notFaked: 'throw',
    setSystemTimeWithoutFakes: 'fake-date-only',
    advanceToNextTimerHonorsSteps: true,
    facadeReturns: 'all',
    messages: {
      notFaked:
        'A function to advance timers was called but the timers APIs are not replaced with fake timers. Call `useFakeTimers()` first.',
    },
  },
  module: {
    factoryShape: 'namespace',
    rootMocksAutoApply: false,
    automock: false,
    actual: 'async-import',
    resetModulesBetween: false,
    injectCjsGlobals: true,
    interopDefault: 'babel',
    resetModulesClearsMocks: false,
    awaitFactory: true,
    // A missing export would otherwise read as `undefined`.
    missingFactoryExport: 'throw',
    requireVirtualFlag: false,
    virtualRelative: true,
    mockValueOwner: 'registration',
    mockResolveKind: 'import',
    // T2.6: R3 makes mock-aware inlining the default (D39, B13d Gap 11).
    mocksReachShared: true,
    // Ours: a frame keeps the name V8 gave it.
    stackFrameNames: 'engine',
    automockShape: 'deep',
    unmockedPathPatterns: [],
    // Empty: `@provino/mock` falls back to its own neutral text for every module message code.
    messages: {},
    // None: a name-mapper miss is a `module-not-found`.
    mapperMiss: null,
  },
  snapshot: {
    header: '// Provino Snapshot v1',
    key: moduleRef<SnapshotKey>(BEHAVIOURS, 'snapshotKey'),
    keyJoin: ' > ',
    hintJoin: ': ',
    dirName: '__snapshots__',
    extension: '.snap',
    format: { escapeString: false, printBasicPrototype: false, maxOutputLength: null, extra: {} },
    serializers: [],
    obsolete: { failLocal: false, failCI: true },
    ciUpdate: 'none',
    updateEnvVar: null,
    throwErrorBody: 'message',
    inline: { indent: 'call', formatter: 'none' },
    printer: null,
    resolvePath: null,
  },
  expect: {
    matcherNamespace: 'provino',
    pollFailsOnTimeout: true,
    diffContextLines: 5,
    valueFormatter: 'pretty-format',
    matcherTable: null,
    errorShape: 'assertion-error',
    equality: { errors: 'assert', invalidDate: 'equal' },
    soft: true,
    poll: { enabled: true, intervalMs: 50, timeoutMs: 1000 },
    requireAssertions: false,
    expand: false,
  },
  orchestrator: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    bail: { checkAfter: 'test' },
    watchDefault: 'never',
    watch: { initialRun: 'all' },
    // Ours: no neutral provider yet; a selection by changed files is refused (T11.16).
    changedFiles: null,
    affected: {
      // Ours: the lexer of `@provino/loader/graph` (speed).
      extractor: null,
      // Ours: a mock beside the file it mocks is an edge; a root mock found by name is not.
      mockEdges: { dir: '__mocks__', adjacent: true, byName: false },
      // Ours: a change to a project's own inputs reruns every file of it.
      invalidateAll: 'project-inputs',
      // Ours: a fresh record of a file's loaded modules beats a rescan (speed: fewer files run).
      graph: 'recorded-then-static',
      // Ours: an edge resolves as the project's workers load the file, with its environment's
      // export conditions (correctness: the selection follows what runs).
      conditions: 'environment',
    },
    globMatchesOn: 'root-relative-path',
    // Ours: a file where nothing ran is skipped.
    todoOnlyFile: 'skip',
    // Ours: no call site is kept with a console write.
    consoleOrigin: 'none',
    // Ours: a file's `process` listeners and `env` changes stay in the file.
    processObject: 'per-file',
    passWithNoTests: false,
    exitCodes: { failure: 1, noTests: 1, unhandled: 1, usage: 2 },
    unhandledErrors: 'fail-run',
    coverageProvider: 'v8',
    coverageReporters: ['text', 'html', 'json'],
    slowTestThresholdMs: 300,
    // DOM globals would leak between files in a shared realm.
    isolationDefault: {
      default: 'registry',
      byEnvironment: { jsdom: 'realm', 'happy-dom': 'realm' },
    },
    envDefault: 'node',
    environmentPragmas: ['provino-environment'],
    environmentConditions: moduleRef<EnvironmentConditions>(BEHAVIOURS, 'environmentConditions'),
    pool: { default: 'forks' },
    runInBand: { auto: false },
    // Ours: no runner to match, so the cheap split that keeps neighbouring files together (P32).
    shard: { fallback: 'path-slice' },
    sequence: { unknownFirst: true },
    // Ours, with Vitest's order and no wrapper text of its own beyond naming the hook.
    globalSetup: {
      signature: 'project-with-teardown',
      teardownOrder: 'reverse',
      failure: moduleRef<GlobalSetupFailure>(BEHAVIOURS, 'globalSetupFailure'),
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
    reportsDirectory: 'coverage',
    // The faster converter, which B25 builds; until then a run that reaches it is refused.
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
})
