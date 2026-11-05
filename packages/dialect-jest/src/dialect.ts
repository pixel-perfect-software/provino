// The Jest 30.5 dialect value (T1.8's Jest half). Policy values only: no config reader, flags or
// facades yet (T11.x, B14/B17). Every value below is copied from the research and marked
// `unverified` until B14's T1.7 checks it against a fixture recorded from the real Jest 30.5
// (CLAUDE.md non-negotiable 2). A comment of the form "runtime corpus X agrees" is a verified
// claim: it moved here with the `core` values from the harness's runtime-corpus profiles, and
// `pnpm test --filter @provino/harness` checks it on every run.
//
// Keys left out, so the neutral value stands. Setting one would be inventing a Jest value.
//
// - No value in the research (B03's key-merge record):
//   core.doneDeprecatedMessage, mock.newCall, mock.messages (Track 4's codes are B13a's),
//   timers.notFaked, timers.setSystemTimeWithoutFakes, timers.facadeReturns,
//   module.missingFactoryExport.
// - Track 1 gives a value that does not map onto the key:
//   timers.fakeTemporal ("via sinon 15.4", a condition on the version of @sinonjs/fake-timers,
//   not true or false; B14 confirms it).
// - A behaviour whose Jest implementation is not built yet, so the key stays the neutral one:
//   core.formatEachTitle (jest-each's titles, T5.4), orchestrator.environmentConditions (the
//   environment's own `exportConditions()`, T8.7).
// - The same as the neutral value, so there is nothing to override:
//   core.orderHooks (`null`: `hookOrder` decides), snapshot.key (`${name} ${n}`, the neutral
//   `snapshotKey` function), snapshot.resolvePath (`null`: the default layout; Jest's is the
//   user's `snapshotResolver`), snapshot.serializers (`[]`: Jest's is the user's list),
//   orchestrator.isolationDefault.byEnvironment (see there).
import { defineDialect, moduleRef } from '@provino/policy'
import type { Dialect, GlobalsFactory, PolicyOverrides } from '@provino/types'
import { jestExpectPolicy } from './expect-policy.ts'

/**
 * Jest 30.5's policy: every key the research gives a Jest value for, layered over the neutral
 * policy by `resolvePolicy`. This is `jestDialect.policy`, typed as the overrides it is (a
 * `Dialect`'s own `policy` is the overrides or a factory).
 * @public
 */
export const jestPolicy: PolicyOverrides = {
  core: {
    // unverified: track-05 L313 (runtime corpus `hook-order` agrees)
    hookOrder: {
      beforeAll: 'declaration',
      beforeEach: 'declaration',
      afterEach: 'declaration',
      afterAll: 'declaration',
    },
    // unverified: track-05 L315 (runtime corpus `concurrent-grouping` agrees)
    eachHooksForConcurrent: false,
    // unverified: track-05 L316
    firstArg: 'done-if-arity',
    // unverified: track-01 L183
    allowGeneratorFns: true,
    // unverified: track-05 L315, L318 (runtime corpus `timeouts` agrees on catchSyncOverrun)
    // unverified: jest-circus 30.5 `test.timeout || testTimeout` (B07 review) for `zero`
    timeouts: { test: 5000, hook: 5000, teardown: 5000, catchSyncOverrun: false, zero: 'default' },
    // unverified: track-05 L321
    nameSeparator: ' ',
    // unverified: track-01 L186
    testNamePatternFlags: 'i',
    // unverified: track-05 L312 (runtime corpus `collection-missing-fn` agrees)
    missingTestFn: 'throw',
    // unverified: track-05 L311 (runtime corpus `collection-async-describe` agrees)
    asyncDescribe: 'throw',
    // unverified: track-01 L189
    nonPromiseReturn: 'fail',
    // unverified: track-01 L191 (`none`)
    eachTitleTruncate: null,
    // unverified: track-05 L319
    retry: { timing: 'deferred', logErrorsBeforeRetry: false, keepEarlierErrors: false },
    // unverified: track-01 L193
    allowOnly: 'always',
    // unverified: track-05 L317
    maxConcurrency: 5,
    // unverified: track-07 L462
    unawaitedAsyncAssertion: 'ignore',
    // unverified: track-05 L314 (runtime corpus `hook-teardowns` agrees)
    hookReturnsCleanup: false,
    // unverified: track-11 L521
    injectGlobals: true,
    collect: {
      // unverified: track-05 L311 (runtime corpus `describe-body` agrees)
      describeBody: 'immediate',
      // unverified: track-05 Findings L46 (runtime corpus `collection-describe-return-value` agrees)
      describeReturnValue: 'error',
      // unverified: track-05 L312 (runtime corpus `collection-test-after-start` agrees)
      lateRegistration: 'fail-file',
      // unverified: track-05 L312 (runtime corpus `collection-describe-hooks-only` agrees)
      emptyDescribe: 'fail-file-if-hooks',
      // unverified: track-05 L47 (runtime corpus `collection-nested-test` agrees)
      nestedInTest: 'fail-test',
      // unverified: track-05 L57 (runtime corpus `collection-todo-with-fn` agrees)
      todoWithFn: 'throw',
      // unverified: jest-each 30.5 registers one failing test for a bad table (B07 review)
      eachTableError: 'failing-test',
    },
    hooks: {
      // unverified: track-05 L314 (runtime corpus `hook-failures` agrees)
      afterError: 'continue',
      // unverified: track-05 L314 (runtime corpus `hook-failures` agrees)
      beforeAllError: 'attach-to-tests',
      // unverified: track-12 L528 (runtime corpus `hook-failures` agrees)
      nestedHooksAfterBeforeAllError: 'run',
      // unverified: track-05 L314 (runtime corpus `hook-failures-after-all` agrees)
      afterAllError: 'unhandled',
      // unverified: not in the research; Jest gives hooks their own timeout
      timeoutCountsTestTimeout: false,
      // unverified: track-12 L528
      skippedBlock: 'run-before-all',
    },
    concurrency: {
      // unverified: track-05 L317 (runtime corpus `concurrent-grouping` agrees)
      grouping: 'hoist-to-first',
      // unverified: track-05 L317
      limitHooks: false,
    },
    // unverified: track-05 L320
    errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' },
    // unverified: track-12 L528
    focus: { scope: 'file', insideSkip: 'runs' },
    // unverified: track-12 L528; expectFail from jest-circus 30.5 `_callCircusTest` (B07 review)
    status: { todoUnderSkip: 'skipped', expectFail: 'body' },
    // unverified: jest-circus 30.5 takes the caller frame (B07 review)
    locationFrame: 'caller',
  },
  lazy: {
    // unverified: track-01 L197
    readInBeforeAll: 'error',
  },
  mock: {
    // unverified: track-01 L198, track-04 L256
    resetTo: 'empty',
    // unverified: track-01 L199, track-04 L253
    defaultName: 'jest.fn()',
    // unverified: track-01 L200, track-04 L275 (Jest has no unstub steps, so they are off)
    between: {
      order: ['clear', 'reset', 'restore'],
      clear: false,
      reset: false,
      restore: false,
      unstubEnvs: false,
      unstubGlobals: false,
    },
    // unverified: track-01 L201, track-04 L261
    classMockPrototype: 'own',
    // unverified: track-04 L254
    spyNameFromMethod: false,
    // unverified: track-04 L255
    functionName: 'mockConstructor',
    // unverified: track-04 L258
    valueShorthandsThrowOnNew: false,
    // unverified: track-04 L259
    fnOfMockReturnsSame: false,
    // unverified: track-04 L260
    copyStaticProps: false,
    // unverified: track-04 L262
    settledResults: false,
    // unverified: track-04 L263
    lastCallKey: 'after-first-call',
    // unverified: track-04 L264
    clearReplacesStateObject: true,
    // unverified: track-04 L265
    mockPropertyWritable: true,
    // unverified: track-04 L266
    withImplementationReturnsMock: false,
    // unverified: track-04 L267
    getImplPrefersOnce: false,
    // unverified: track-04 L268
    spyReportsBridgeImpl: true,
    // unverified: track-04 L269
    isMockAcceptsObjects: true,
    // unverified: track-04 L270
    spyInstall: 'assign',
  },
  timers: {
    // unverified: track-01 L202, track-04 L348 (`excludeFromDefaultToFake: []`)
    toFakeDefault: 'all',
    // unverified: track-01 L203, track-04 L349
    loopLimit: 100000,
    // unverified: track-01 L205
    legacyAvailable: true,
    // unverified: track-01 L206
    enableGlobally: false,
    // unverified: track-04 L350
    optionNames: 'do-not-fake',
    // unverified: track-04 L353
    advanceToNextTimerHonorsSteps: true,
  },
  module: {
    // unverified: track-01 L207, track-04 L308 (a factory returns `module.exports`)
    factoryShape: 'module-value',
    // unverified: track-02 L453, track-04 L311
    rootMocksAutoApply: true,
    // unverified: track-01 L209
    automock: false,
    // unverified: track-01 L210
    actual: 'sync-require',
    // unverified: track-01 L213
    resetModulesBetween: false,
    // unverified: track-01 L214
    injectCjsGlobals: true,
    // unverified: track-02 L452
    interopDefault: 'babel',
    // unverified: track-02 L454
    resetModulesClearsMocks: false,
    // unverified: track-04 L309
    awaitFactory: false,
    // unverified: track-04 L312
    resetModulesReRunsFactory: true,
    // unverified: track-04 L313
    requireVirtualFlag: true,
    // unverified: track-04 L314
    automockShape: 'metadata',
    // unverified: track-04 L316
    unmockedPathPatterns: [],
  },
  snapshot: {
    // unverified: track-01 L215, track-07 L468, track-11 L520
    header: '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing',
    // unverified: track-07 L469
    keyJoin: ' ',
    // unverified: track-07 L469
    hintJoin: ': ',
    // unverified: track-01 L217
    dirName: '__snapshots__',
    // unverified: track-01 L217
    extension: '.snap',
    // unverified: track-01 L218, track-07 L474 (no `maxOutputLength`: unlimited)
    format: { escapeString: false, printBasicPrototype: false, maxOutputLength: null },
    // unverified: track-07 L472 (track-01 L220 says `report` for both; Track 7's detail is used)
    obsolete: { failLocal: true, failCI: true },
    // unverified: track-01 L220, track-07 L473
    ciUpdate: 'none',
    // unverified: track-07 L473 (only Vitest has `UPDATE_SNAPSHOT`)
    updateEnvVar: null,
    // unverified: track-07 L470
    throwErrorBody: 'message',
    // unverified: track-07 L471
    inline: { indent: 'column0', formatter: 'prettier' },
  },
  expect: jestExpectPolicy,
  orchestrator: {
    // unverified: track-11 L68 (`testMatch` default; Track 1 L224 says `__tests__` plus `.test`/`.spec`)
    include: ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'],
    // unverified: track-11 L68 (`testPathIgnorePatterns` default `['/node_modules/']`, a regular expression there and the same path as a glob here)
    exclude: ['**/node_modules/**'],
    // unverified: track-09 L557
    bail: { checkAfter: 'file' },
    // unverified: track-01 L226, track-09 L561
    watchDefault: 'never',
    // unverified: track-09 L560 (`all` with `--watchAll`)
    watch: { initialRun: 'changed' },
    // unverified: track-01 L227
    passWithNoTests: false,
    // unverified: track-01 L228, track-09 L563
    exitCodes: { failure: 1, noTests: 1, unhandled: 1 },
    // unverified: track-01 L229
    unhandledErrors: 'fail-run',
    // unverified: track-01 L230, track-08 L516
    coverageProvider: 'istanbul',
    // unverified: track-01 L230, track-08 L519
    coverageReporters: ['json', 'text', 'lcov', 'clover'],
    // unverified: track-01 L231
    slowTestThresholdMs: 5000,
    // `registry` is DECISIONS D6 (Track 1 L232 and Track 2 L455 said `realm`); an own key of ours,
    // so it needs a test, not ground truth. `byEnvironment` is left to the neutral value
    // (jsdom and happy-dom on `realm`): D6 sets the default only.
    isolationDefault: { default: 'registry' },
    // unverified: track-01 L232
    envDefault: 'node',
    // unverified: track-08 L515
    environmentPragmas: ['jest-environment'],
    // unverified: track-09 L555 (`threads` with `workerThreads`)
    pool: { default: 'forks' },
    // unverified: track-09 L556 (Jest's "20 fast files" rule)
    runInBand: { auto: true },
    // unverified: track-09 L558
    shard: { fallback: 'sha1-slice' },
    // unverified: track-09 L559
    sequence: { unknownFirst: true },
    // unverified: track-09 L564
    globalSetup: { signature: 'global-and-project-config' },
  },
  report: {
    // unverified: track-01 L233
    displaySeparator: ' › ',
    // unverified: track-01 L234, track-09 L562
    defaultReporters: ['default'],
    // unverified: track-01 L234
    failureTitleBullet: ' ●  ',
    // unverified: track-11 L522
    resultStatusSkipped: 'pending',
  },
  coverage: {
    // unverified: track-08 L517
    thresholdGrouping: 'first-match',
    // unverified: track-08 L518
    globThresholdScope: 'per-file',
    // unverified: track-08 L521 (when `collectCoverageFrom` is set)
    includeUntestedByDefault: true,
    // unverified: track-08 L520
    reportsDirectory: 'coverage',
  },
}

/**
 * The globals Jest 30.5 injects into a test file: jest-circus's (`describe`, `it`, `test`, the
 * hooks, their `f`/`x` aliases), `expect`, and the `jest` object. `jestGlobals` returns exactly
 * these keys.
 * unverified: jest-circus 30.5.2 `jestAdapterInit` (`globalsObject`), read from source, not recorded
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
})
