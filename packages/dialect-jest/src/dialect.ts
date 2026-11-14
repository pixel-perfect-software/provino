// The Jest 30.5 dialect value (T1.8's Jest half). Policy values only: no config reader, flags or
// facades yet (T11.x, B14/B17). Every value matches Jest 30.5.2, and the evidence for each is in
// `@provino/harness`'s `src/policy-truth/claims/` (T1.7, CLAUDE.md non-negotiable 2): a golden
// recorded from the real Jest, a corpus check a flipped value fails, our own key with its test, or
// a `pending` entry naming its owner. `policy-truth.test.ts` fails when a value and its evidence
// disagree. A `research:` comment says where a value first came from; "corpus X agrees" names one
// of the corpus fixtures the claim lists.
//
// Keys left out, so the neutral value stands. Setting one would be inventing a Jest value.
//
// - Recorded equal to the neutral value: none now. (`timers.notFaked` and `setSystemTimeWithoutFakes`
//   were here; B14a recorded Jest's and sets them. `module.missingFactoryExport` and
//   `module.messages` were too; B13b sets them. `timers.facadeReturns` and `timers.fakeTemporal`
//   were; B17a records them as `mocking/timers-facade` and `policy/timers-temporal`.)
// - The same as the neutral value, so there is nothing to override:
//   core.orderHooks (`null`: `hookOrder` decides), snapshot.key (`${name} ${n}`, the neutral
//   `snapshotKey` function), snapshot.resolvePath (`null`: the default layout; Jest's is the
//   user's `snapshotResolver`), snapshot.serializers (`[]`: Jest's is the user's list),
//   core.retry.functionConditionWarning (Jest has no `retry.condition` to warn about),
//   orchestrator.isolationDefault.byEnvironment (see there).
import { defineDialect, moduleRef } from '@provino/policy'
import type {
  Dialect,
  EnvironmentConditions,
  EnvironmentResolver,
  FormatEachTitle,
  FormatMapperMiss,
  FormatValue,
  GlobalSetupFailure,
  GlobalsFactory,
  InlineSnapshotWriterFactory,
  ModuleScopeFactory,
  PolicyOverrides,
  SnapshotPrinterFactory,
  SnapshotResolverFactory,
} from '@provino/types'
import { jestExpectPolicy } from './expect-policy.ts'
import { jestHoistPolicy } from './hoist-policy.ts'
import { jestMockPolicy } from './mock-policy.ts'

/**
 * Jest 30.5's policy: every key the research gives a Jest value for, layered over the neutral
 * policy by `resolvePolicy`. This is `jestDialect.policy`, typed as the overrides it is (a
 * `Dialect`'s own `policy` is the overrides or a factory).
 * @public
 */
export const jestPolicy: PolicyOverrides = {
  core: {
    // research: track-05 L313 (runtime corpus `hook-order` agrees)
    hookOrder: {
      beforeAll: 'declaration',
      beforeEach: 'declaration',
      afterEach: 'declaration',
      afterAll: 'declaration',
    },
    // research: track-05 L315 (runtime corpus `concurrent-grouping` agrees)
    eachHooksForConcurrent: false,
    // research: track-05 L316
    firstArg: 'done-if-arity',
    // research: track-01 L183
    allowGeneratorFns: true,
    // research: track-05 L315, L318 (runtime corpus `timeouts` agrees on catchSyncOverrun)
    // research: jest-circus 30.5 `test.timeout || testTimeout` (B07 review) for `zero`
    timeouts: { test: 5000, hook: 5000, teardown: 5000, catchSyncOverrun: false, zero: 'default' },
    // research: track-05 L321
    nameSeparator: ' ',
    // research: track-01 L186
    testNamePatternFlags: 'i',
    // research: track-05 L312 (runtime corpus `collection-missing-fn` agrees)
    missingTestFn: 'throw',
    // research: track-05 L311 (runtime corpus `collection-async-describe` agrees)
    asyncDescribe: 'throw',
    // research: track-01 L189
    nonPromiseReturn: 'fail',
    // jest-each 30.5.2's `formatTitle` and `interpolateVariables` (`src/each/`), exported by `/runtime`.
    formatEachTitle: moduleRef<FormatEachTitle>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'formatEachTitle',
    ),
    // jest-circus 30.5's `prettyFormat(value, { maxDepth: 3 })` (`src/runtime/format-value.ts`) in the
    // messages `done` and a non-promise return build (runtime corpus `done-callback` agrees).
    formatValue: moduleRef<FormatValue>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'formatValue',
    ),
    // Jest passes `done`, not a context: nothing to call (runtime corpus `done-callback` agrees).
    doneDeprecatedMessage: null,
    // research: track-01 L191 (`none`)
    eachTitleTruncate: null,
    // research: track-05 L319. `functionCondition` is the neutral `call`: Jest's `jest.retryTimes`
    // has no `condition`, so nothing reads it, or `functionConditionWarning` (left at the neutral
    // text): their claims are `own`.
    retry: {
      timing: 'deferred',
      keepEarlierErrors: false,
      functionCondition: 'call',
    },
    // research: track-01 L193
    allowOnly: 'always',
    // research: track-05 L317
    maxConcurrency: 5,
    // research: track-07 L462
    unawaitedAsyncAssertion: 'ignore',
    // research: track-05 L314 (runtime corpus `hook-teardowns` agrees)
    hookReturnsCleanup: false,
    // research: track-11 L521
    injectGlobals: true,
    // jest-runner runs `setupFiles` before jest-circus installs its globals; `jest` is each
    // module's own (`policy/core-globals-at-setup`).
    globalsBeforeSetupFiles: ['jest'],
    collect: {
      // research: track-05 L311 (runtime corpus `describe-body` agrees)
      describeBody: 'immediate',
      // research: track-05 Findings L46 (runtime corpus `collection-describe-return-value` agrees)
      describeReturnValue: 'error',
      // research: track-05 L312 (runtime corpus `collection-test-after-start` agrees)
      lateRegistration: 'fail-file',
      // research: track-05 L312 (runtime corpus `collection-describe-hooks-only` agrees)
      emptyDescribe: 'fail-file-if-hooks',
      // research: track-05 L47 (runtime corpus `collection-nested-test` agrees)
      nestedInTest: 'fail-test',
      // research: track-05 L57 (runtime corpus `collection-todo-with-fn` agrees)
      todoWithFn: 'throw',
      // research: jest-each 30.5 registers one failing test for a bad table (B07 review)
      eachTableError: 'failing-test',
    },
    hooks: {
      // research: track-05 L314 (runtime corpus `hook-failures` agrees)
      afterError: 'continue',
      // research: track-05 L314 (runtime corpus `hook-failures` agrees)
      beforeAllError: 'attach-to-tests',
      // research: track-12 L528 (runtime corpus `hook-failures` agrees)
      nestedHooksAfterBeforeAllError: 'run',
      // research: track-05 L314 (runtime corpus `hook-failures-after-all` agrees)
      afterAllError: 'unhandled',
      // research: not in the research; Jest gives hooks their own timeout
      timeoutCountsTestTimeout: false,
      // research: track-12 L528
      skippedBlock: 'run-before-all',
    },
    concurrency: {
      // research: track-05 L317 (runtime corpus `concurrent-grouping` agrees)
      grouping: 'hoist-to-first',
      // research: track-05 L317
      limitHooks: false,
    },
    // research: track-05 L320
    errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' },
    // research: track-12 L528
    focus: { scope: 'file', insideSkip: 'runs' },
    // research: track-12 L528; expectFail from jest-circus 30.5 `_callCircusTest` (B07 review)
    status: { todoUnderSkip: 'skipped', expectFail: 'body' },
    // research: jest-circus 30.5 takes the caller frame (B07 review)
    locationFrame: 'caller',
  },
  lazy: {
    // research: track-01 L197
    readInBeforeAll: 'error',
  },
  mock: jestMockPolicy,
  timers: {
    // research: track-01 L202, track-04 L348 (`excludeFromDefaultToFake: []`)
    toFakeDefault: 'all',
    // research: track-01 L203, track-04 L349
    loopLimit: 100000,
    // research: track-01 L205
    legacyAvailable: true,
    // research: track-01 L206
    enableGlobally: false,
    // research: track-04 L350
    optionNames: 'do-not-fake',
    // research: track-04 L353
    advanceToNextTimerHonorsSteps: true,
    // Without fake timers an advance call and setSystemTime warn and do nothing
    // (`policy/timers`); the neutral value throws.
    notFaked: 'warn',
    setSystemTimeWithoutFakes: 'warn-noop',
    // Faked when the environment has a `Temporal` (@sinonjs/fake-timers 15.4 puts it in `timers`).
    fakeTemporal: true,
    // `useFakeTimers`, `useRealTimers` and `setTimerTickMode` return `jest`; the rest return nothing.
    facadeReturns: 'lifecycle',
    // @jest/fake-timers 30.5.2 `modernFakeTimers.ts` `_checkFakeTimers`; the frames follow `{stack}`.
    messages: {
      notFaked:
        "A function to advance timers was called but the timers APIs are not replaced with fake timers. Call `jest.useFakeTimers()` in this test file or enable fake timers for all tests by setting 'fakeTimers': {'enableGlobally': true} in Jest configuration file.\nStack Trace:\n{stack}",
    },
  },
  module: {
    // research: track-01 L207, track-04 L308 (a factory returns `module.exports`)
    factoryShape: 'module-value',
    // research: track-02 L453, track-04 L311
    rootMocksAutoApply: true,
    // research: track-01 L209
    automock: false,
    // research: track-01 L210
    actual: 'sync-require',
    // research: track-01 L213
    resetModulesBetween: false,
    // research: track-01 L214
    injectCjsGlobals: true,
    // research: track-02 L452
    interopDefault: 'babel',
    // research: track-02 L454
    resetModulesClearsMocks: false,
    // research: track-04 L309
    awaitFactory: false,
    // research: track-04 L313
    requireVirtualFlag: true,
    // research: track-04 L313 (mod corpus agrees: `mod-virtual-static`)
    virtualRelative: true,
    // Recorded, Jest 30.5.2: `mod-reregister` (a second `doMock` after a load leaves the next load on
    // the first factory's value) and `mod-reset-modules` (`resetModules()` runs the factory again).
    // The value lives in `ModuleRegistries.mockRegistry`.
    mockValueOwner: 'module-registry',
    // Recorded, Jest 30.5.2: `mod-conditions` (a `require`-only package mocks, an `import`-only one is not found).
    mockResolveKind: 'require',
    // Recorded, Jest 30.5.2: `mod-shared-dep` and `mod-shared-dep-root` (a mock reaches the packages that require it).
    mocksReachShared: true,
    // jest-source-map names a frame after the map's name at its own position (`cli/failure-frames`).
    stackFrameNames: 'mapped-name',
    // research: track-04 L314
    automockShape: 'metadata',
    // research: track-04 L316
    unmockedPathPatterns: [],
    // research: track-04 L310 (mod corpus agrees: `mod-factory-shape`, reading `b` gives `undefined`)
    missingFactoryExport: 'undefined',
    // The registry's error texts, copied from the Jest 30.5 sources under `.refs/jest`.
    // research: track-04 L310 (mod corpus agrees)
    messages: {
      // jest-resolve `resolver.ts` L523 (`_throwModNotFoundError`), then the hint jest-runtime adds
      // in `internals/MockState.ts` L377 (`getModuleIdForMockRegistration`). `{from}` is the
      // importer's path relative to the root, as jest-resolve prints it.
      'module-missing':
        "Cannot find module '{specifier}' from '{from}'\n\nTo mock a module that does not exist on disk, pass `{virtual: true}` in the mock options. See https://jestjs.io/docs/jest-object#jestmockmodulename-factory-options",
      // The same without the hint, for `unmock`/`dontMock` of a missing module (`mod-unmock-missing`):
      // jest-resolve `resolver.ts` L523 (`_throwModNotFoundError`).
      'unmock-module-missing': "Cannot find module '{specifier}' from '{from}'",
      // jest-runtime `internals/MockState.ts` L552-L554 (`generateMock`); `{id}` is the module path.
      'automock-no-metadata':
        'Failed to get mock metadata: {id}\n\nSee: https://jestjs.io/docs/manual-mocks#content',
      // jest-runtime `internals/ModuleRegistries.ts` L132 (`enterIsolated`).
      'nested-isolation': '{caller} cannot be nested inside another {caller} or {other}.',
      // The loader's text for a transform error (B13c Gap 4): Babel's, which babel-jest throws as
      // `<file>: <message>` with no position. Recorded: `mod-factory-out-of-scope` (Jest 30.5.2).
      'transform-failed': '{file}: {message}',
      // The loader's text for a module that isn't found when its `require` runs: jest-resolve
      // `resolver.ts` L523 (`_throwModNotFoundError`), `{from}` relative to the root. Recorded:
      // `mod-root-package-uninstalled` ("load after dontMock").
      'module-not-found': "Cannot find module '{specifier}' from '{from}'",
    },
    // jest-resolve `resolver.ts` L1024-L1052 (`createNoMappedModuleFoundError`): a
    // `moduleNameMapper` rule matched and none of its targets resolved. Recorded: `resolve/mapper-miss`.
    mapperMiss: moduleRef<FormatMapperMiss>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'formatMapperMiss',
    ),
  },
  snapshot: {
    // research: track-01 L215, track-07 L468, track-11 L520
    header: '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing',
    // research: track-07 L469
    keyJoin: ' ',
    // research: track-07 L469
    hintJoin: ': ',
    // research: track-01 L217
    dirName: '__snapshots__',
    // research: track-01 L217
    extension: '.snap',
    // research: track-01 L218, track-07 L474 (no `maxOutputLength`: unlimited)
    format: { escapeString: false, printBasicPrototype: false, maxOutputLength: null, extra: {} },
    // research: track-07 L472 (track-01 L220 says `report` for both; Track 7's detail is used)
    obsolete: { failLocal: true, failCI: true },
    // Provino's own key (B23d B1, DV96): Jest's `cleanup` after the run
    // (`cli/report-snapshot-obsolete-file`).
    obsoleteFiles: 'report',
    // research: track-01 L220, track-07 L473
    ciUpdate: 'none',
    // research: track-07 L473 (only Vitest has `UPDATE_SNAPSHOT`)
    updateEnvVar: null,
    // research: track-07 L470
    throwErrorBody: 'message',
    inline: {
      // research: track-07 L471
      indent: 'column0',
      // research: track-07 L471
      formatter: 'prettier',
      // Provino's own key (B23d B1, D113, D122): jest-snapshot 30.5.2's writer, rebuilt, loaded in
      // the coordinator only when a run writes an inline snapshot.
      writer: moduleRef<InlineSnapshotWriterFactory>(
        import.meta.resolve('@provino/dialect-jest/inline-snapshots'),
        'jestInlineSnapshotWriter',
      ),
      // Provino's own key: project data, filled by the config reader from `prettierPath`.
      prettierPath: null,
    },
    // Provino's own key (B23d B1): jest-snapshot 30.5.2's `SnapshotResolver.ts`, rebuilt.
    resolverFactory: moduleRef<SnapshotResolverFactory>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'jestSnapshotResolver',
    ),
    // Provino's own key (T7.10): Jest's `pretty-format` 30.5 with its plugin order, and its words.
    // Resolved here, so the worker's loader finds it from any package.
    printer: moduleRef<SnapshotPrinterFactory>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'jestSnapshotPrinter',
    ),
  },
  expect: jestExpectPolicy,
  orchestrator: {
    // research: track-11 L68 (`testMatch` default; Track 1 L224 says `__tests__` plus `.test`/`.spec`)
    include: ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'],
    // research: track-11 L68 (`testPathIgnorePatterns` default `['/node_modules/']`, a regular expression there and the same path as a glob here)
    exclude: ['**/node_modules/**'],
    // research: track-09 L557
    bail: { checkAfter: 'file' },
    // research: track-01 L226, track-09 L561
    watchDefault: 'never',
    // research: track-09 L560 (`all` with `--watchAll`)
    watch: { initialRun: 'changed' },
    // jest-runtime reads the environment's `exportConditions()`; the coordinator can't build the
    // class, so the behaviour answers for the packages Jest ships and `customExportConditions`.
    environmentConditions: moduleRef<EnvironmentConditions>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'jestEnvironmentConditions',
    ),
    // Ours: Jest's `testMatch` is picomatch on the absolute path (`policy/orchestrator-match-path`).
    globMatchesOn: 'absolute-path',
    // Jest marks a suite skipped only when every test is pending (`cli/report-todo-only`, DV50).
    todoOnlyFile: 'pass',
    // Jest's BufferedConsole keeps the call site of every entry (`cli/report-default`).
    consoleOrigin: 'stack',
    // jest-util's `installCommonGlobals` gives every file its own copy of `process`: a later file
    // in the worker sees none of an earlier one's listeners or `env` changes
    // (`env/process-per-file-listeners`, `env/process-per-file-env`).
    processObject: 'per-file',
    // research: track-01 L227
    passWithNoTests: false,
    // research: track-01 L228, track-09 L563; `usage` is `cli/unknown-flag` and `cli/bad-config`.
    exitCodes: { failure: 1, noTests: 1, unhandled: 1, usage: 1 },
    // research: track-01 L229
    unhandledErrors: 'fail-run',
    // research: track-01 L230, track-08 L516
    coverageProvider: 'istanbul',
    // research: track-01 L230, track-08 L519
    coverageReporters: ['json', 'text', 'lcov', 'clover'],
    // research: track-01 L231
    slowTestThresholdMs: 5000,
    // `registry` is DECISIONS D6 (Track 1 L232 and Track 2 L455 said `realm`); an own key of ours,
    // so it needs a test, not ground truth. `byEnvironment` is left to the neutral value
    // (jsdom and happy-dom on `realm`): D6 sets the default only.
    isolationDefault: { default: 'registry' },
    // research: track-01 L232
    envDefault: 'node',
    // research: track-08 L515
    environmentPragmas: ['jest-environment'],
    // research: track-09 L555 (`threads` with `workerThreads`)
    pool: { default: 'forks' },
    // research: track-09 L556 (Jest's "20 fast files" rule)
    runInBand: { auto: true },
    // Recorded from Jest 30.5.2: `cli/shard-1-of-3`, `-2-of-3` and `-3-of-3` (jest-test-sequencer's
    // `shard`: the sha1 of the root-relative path, then slices by count).
    shard: { fallback: 'sha1-slice' },
    // research: track-09 L559
    sequence: { unknownFirst: true },
    // research: track-09 L564 (the signature); the other two are recorded (`cli/global-setup-projects`,
    // `cli/global-setup-throws` and its three siblings)
    globalSetup: {
      signature: 'global-and-project-config',
      teardownOrder: 'in-order',
      // `runGlobalHook` rewrites a thrown Error's message in place and prints anything else with
      // `prettyFormat(error, { maxDepth: 3 })`. The coordinator loads it, so it is a leaf of its
      // own and not the worker's whole `/runtime` entry.
      failure: moduleRef<GlobalSetupFailure>(
        import.meta.resolve('@provino/dialect-jest/global-setup'),
        'globalSetupFailure',
      ),
    },
  },
  report: {
    // research: track-01 L233
    displaySeparator: ' › ',
    // research: track-01 L234, track-09 L562
    defaultReporters: ['default'],
    // Jest lists every test of a run of one file (`cli/report-single-file`).
    listTestsForSingleFile: true,
    // research: track-01 L234
    // Two spaces, the bullet, one space (`policy/report-default`; Track 1 had ' ●  ').
    failureTitleBullet: '  ● ',
    // research: track-11 L522
    resultStatusSkipped: 'pending',
  },
  coverage: {
    // research: track-08 L517
    thresholdGrouping: 'first-match',
    // research: track-08 L518
    globThresholdScope: 'per-file',
    // research: track-08 L521 (when `collectCoverageFrom` is set)
    includeUntestedByDefault: true,
    // research: track-08 L520
    reportsDirectory: 'coverage',
    // research: track-08 F10 (Jest's v8 provider runs v8-to-istanbul; B23b records it)
    v8Conversion: 'v8-to-istanbul',
    // research: track-08 F10 (jest-runtime starts precise coverage with `callCount: true`)
    v8HitCounts: true,
    // research: track-08 F9 (babel-plugin-istanbul's default `coverageVariable`)
    istanbulVariable: '__coverage__',
    thresholdMessages: {
      // research: track-08 F11 (jest-reporters CoverageReporter.ts L271)
      belowMinimum:
        'Jest: Coverage for {metric} ({actual}%) does not meet "{name}" threshold ({threshold}%)',
      // research: track-08 F11 (CoverageReporter.ts L265)
      aboveMaximumUncovered:
        'Jest: Uncovered count for {metric} ({actual}) exceeds {name} threshold ({threshold})',
      // research: track-08 F11 (CoverageReporter.ts L448)
      notFound: 'Jest: Coverage data for {path} was not found.',
    },
  },
}

/**
 * The served specifiers a `moduleNameMapper` rule takes over. `@jest/globals` is answered before
 * the mapper (jest-runtime `requireModuleOrMock`), but `expect`, `@jest/expect` and `jest-mock` go
 * through it as any bare specifier does. Recorded: `resolve/alias-order`, `resolve/alias-jest-mock`.
 * Jest's own runner takes a mapped `expect` too, which crashes every file (`resolve/alias-expect`,
 * `resolve/alias-jest-expect`); Provino's runner keeps its own and only the project's requires see
 * the mapped module (a proposed DIVERGENCE).
 */
const JEST_MAPPABLE_MODULES: readonly string[] = ['@jest/expect', 'expect', 'jest-mock']

/** The specifiers the Jest dialect serves from its facades (U9). */
const JEST_SERVED_MODULES: readonly string[] = ['@jest/globals', ...JEST_MAPPABLE_MODULES]

/**
 * The globals Jest 30.5 injects into a test file: jest-circus's (`describe`, `it`, `test`, the
 * hooks, their `f`/`x` aliases), `expect`, and the `jest` object. `jestGlobals` returns exactly
 * these keys.
 * research: jest-circus 30.5.2 `jestAdapterInit` (`globalsObject`), read from source, not recorded
 */
const JEST_GLOBAL_NAMES: readonly string[] = [
  'afterAll',
  'afterEach',
  'beforeAll',
  'beforeEach',
  'describe',
  'expect',
  'fdescribe',
  'fit',
  'it',
  'jest',
  'test',
  'xdescribe',
  'xit',
  'xtest',
]

/**
 * What a project config may put under `jest`: nothing yet, so only an empty object. Jest's own
 * options arrive with the config reader (T11.x, B14).
 * @public
 */
export type JestDialectOptions = Record<string, never>

// Registers the dialect's name: with this package imported, `{ dialect: 'jest' }` is a valid
// `ProjectConfig`, and `jest` is a config key of its own type. Declaration merging is program-wide,
// so a program that imports the package (or only its types) sees it.
declare module '@provino/types' {
  interface DialectRegistry {
    jest: JestDialectOptions
  }
}

/**
 * The Jest 30.5 dialect: its policy values and the globals it injects. The config reader, the CLI
 * flags and the `@jest/globals` facade come with T11.x and T11.10 (B14, B17).
 * @public
 */
export const jestDialect: Dialect<'jest'> = defineDialect({
  name: 'jest',
  version: '30.5',
  policy: jestPolicy,
  // Resolved here, so the worker's loader finds it from any package (a bare specifier would
  // resolve from @provino/policy).
  globals: {
    factory: moduleRef<GlobalsFactory>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'jestGlobals',
    ),
    names: JEST_GLOBAL_NAMES,
  },
  // `createProjectLoader` hoists with it; `config` copies it to the worker by value (B13c).
  loader: { hoist: jestHoistPolicy },
  // A test file's `@jest-environment` docblock is resolved in the worker, from the project's root.
  environmentResolver: moduleRef<EnvironmentResolver>(
    import.meta.resolve('@provino/dialect-jest/runtime'),
    'jestEnvironmentFor',
  ),
  // Each module gets its own `jest`, as jest-runtime's `_createJestObjectFor(from)` does: a
  // `jest.mock` resolves from the module that calls it. Recorded: every Jest `mod-*` fixture whose
  // helper registers a mock (`mod-require-esm-helper`, `mod-adjacent`).
  moduleScope: {
    names: ['jest'],
    // jest-runtime answers `@jest/globals` itself (`requireModuleOrMock`), and `@jest/expect` and
    // `expect` from the framework's own registry (`FRAMEWORK_SINGLETON_MODULES`); U9 also serves
    // `jest-mock` from Provino's facade. `@jest/globals` never goes through `moduleNameMapper` or the resolver; the others yield to a rule.
    modules: JEST_SERVED_MODULES,
    mappable: JEST_MAPPABLE_MODULES,
    factory: moduleRef<ModuleScopeFactory>(
      import.meta.resolve('@provino/dialect-jest/runtime'),
      'jestModuleScope',
    ),
  },
})
