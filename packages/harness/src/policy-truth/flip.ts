// The flipped values of a policy leaf (T1.7): what `policy-truth.test.ts` puts in a leaf's place to
// show its evidence would catch a wrong value. An enumerated key flips to every other value of its
// type (`DOMAINS`, copied from `@provino/types`; a test checks each dialect value is in its
// domain). Anything else flips to one value of the same type that differs: a boolean to its
// negation, a number to the next one, a string gains a prefix and a suffix, an array is reversed or emptied
// (or, empty, gains an entry), and `null` becomes a value of the type next to it. A behaviour ref
// has no such flip; one that a corpus can hold to its goldens flips to the neutral behaviour, and to
// other refs where the claim tells refs apart (`REF_FLIPS`).
import { isDeepStrictEqual } from 'node:util'
import { neutralPolicy } from '@provino/policy'
import type { ShardFallback } from '@provino/types'

/** Every value of each enumerated policy key, by its path relative to its slice's root. */
export const DOMAINS: Readonly<Record<string, readonly string[]>> = {
  'core.hookOrder.beforeAll': ['declaration', 'reverse', 'parallel'],
  'core.hookOrder.beforeEach': ['declaration', 'reverse', 'parallel'],
  'core.hookOrder.afterEach': ['declaration', 'reverse', 'parallel'],
  'core.hookOrder.afterAll': ['declaration', 'reverse', 'parallel'],
  'core.firstArg': ['done-if-arity', 'context'],
  'core.definitions.extendApi': ['expose', 'absent'],
  'core.definitions.plainSuiteHook': ['pass-suite', 'refuse-fixtures'],
  'core.timeouts.zero': ['default', 'none'],
  'core.missingTestFn': ['throw', 'todo'],
  'core.asyncDescribe': ['throw', 'await'],
  'core.nonPromiseReturn': ['fail', 'ignore'],
  'core.retry.timing': ['deferred', 'immediate'],
  'core.retry.functionCondition': ['call', 'ignore-warn'],
  'core.allowOnly': ['always', 'not-in-ci'],
  'core.unawaitedAsyncAssertion': ['ignore', 'fail'],
  'core.collect.describeBody': ['immediate', 'deferred'],
  'core.collect.describeReturnValue': ['error', 'ignore'],
  'core.collect.lateRegistration': ['fail-file', 'warn-drop'],
  'core.collect.emptyDescribe': ['fail-file-if-hooks', 'fail-suite', 'allow'],
  'core.collect.nestedInTest': ['fail-test', 'throw'],
  'core.collect.todoWithFn': ['throw', 'todo'],
  'core.collect.eachTableError': ['failing-test', 'lenient'],
  'core.hooks.afterError': ['continue', 'abort-chain'],
  'core.hooks.beforeAllError': ['attach-to-tests', 'skip-subtree'],
  'core.hooks.nestedHooksAfterBeforeAllError': ['run', 'skip'],
  'core.hooks.afterAllError': ['unhandled', 'fail-suite'],
  'core.hooks.skippedBlock': ['run-before-all', 'none'],
  'core.concurrency.grouping': ['hoist-to-first', 'consecutive'],
  'core.errors.lateErrors': ['fail-owner', 'report-run'],
  'core.errors.processListeners': ['alongside', 'per-file'],
  'core.errors.hasAssertionsWhenFailed': ['skip', 'check'],
  'core.focus.scope': ['file', 'suite'],
  'core.focus.insideSkip': ['runs', 'skipped'],
  'core.status.todoUnderSkip': ['skipped', 'todo'],
  'core.status.expectFail': ['body', 'attempt'],
  'core.locationFrame': ['caller', 'test-file'],
  'lazy.readInBeforeAll': ['error', 'allow'],
  'mock.resetTo': ['empty', 'original-impl'],
  'mock.classMockPrototype': ['own', 'chain-to-impl'],
  'mock.functionName': ['mockConstructor', 'impl-or-Mock'],
  'mock.newCall': ['apply', 'construct'],
  'mock.lastCallKey': ['after-first-call', 'always'],
  'mock.spyInstall': ['assign', 'define'],
  'timers.toFakeDefault': ['all', 'all-but-microtasks'],
  'timers.optionNames': ['do-not-fake', 'to-fake'],
  'timers.notFaked': ['warn', 'throw'],
  'timers.setSystemTimeWithoutFakes': ['warn-noop', 'fake-date-only'],
  'timers.facadeReturns': ['lifecycle', 'all'],
  'module.factoryShape': ['module-value', 'namespace'],
  'module.actual': ['sync-require', 'async-import'],
  'module.interopDefault': ['babel', 'node'],
  'module.missingFactoryExport': ['undefined', 'throw'],
  'module.mockValueOwner': ['module-registry', 'registration'],
  'module.mockResolveKind': ['require', 'import'],
  'module.edgeResolveKind': ['as-written', 'importer-format'],
  'module.moduleSyncCondition': ['never', 'import-and-sync-require'],
  'module.assetImports': ['off', 'built-in'],
  'module.automockShape': ['metadata', 'deep'],
  'module.stackFrameNames': ['mapped-name', 'engine'],
  'module.nativeLoadPatches': ['apply', 'skip'],
  'snapshot.ciUpdate': ['new', 'none'],
  'snapshot.throwErrorBody': ['message', 'error'],
  'snapshot.inline.indent': ['column0', 'call'],
  'snapshot.inline.formatter': ['prettier', 'none'],
  'snapshot.obsoleteFiles': ['report', 'ignore'],
  'expect.valueFormatter': ['pretty-format'],
  'expect.errorShape': ['matcher-result', 'assertion-error'],
  'expect.settlementCheck': ['at-call', 'at-read'],
  'expect.equality.errors': ['message', 'assert'],
  'expect.equality.invalidDate': ['unequal', 'equal'],
  'orchestrator.bail.checkAfter': ['file', 'test'],
  'orchestrator.watchDefault': ['never', 'tty-not-ci'],
  'orchestrator.watch.initialRun': ['changed', 'all'],
  'orchestrator.watch.interruptedFiles': ['report', 'drop'],
  'orchestrator.globMatchesOn': ['absolute-path', 'root-relative-path'],
  'orchestrator.todoOnlyFile': ['pass', 'skip'],
  'orchestrator.noTestsFile': ['fail', 'fail-unless-pass-with-no-tests', 'pass'],
  'orchestrator.consoleOrigin': ['stack', 'none'],
  'orchestrator.processObject': ['per-file', 'shared'],
  'orchestrator.unhandledErrors': ['fail-run', 'ignore'],
  'orchestrator.coverageProvider': ['v8', 'istanbul'],
  'orchestrator.isolationDefault.default': ['none', 'registry', 'realm', 'process'],
  'orchestrator.pool.default': ['forks', 'threads', 'inline'],
  'orchestrator.shard.fallback': [
    'sha1-slice',
    'rooted-sha1-slice',
    'path-slice',
  ] satisfies readonly ShardFallback[],
  'orchestrator.globalSetup.signature': ['global-and-project-config', 'project-with-teardown'],
  'orchestrator.globalSetup.teardownOrder': ['in-order', 'reverse'],
  'orchestrator.affected.invalidateAll': ['project-inputs', 'none'],
  'orchestrator.affected.graph': ['static', 'recorded-then-static'],
  'orchestrator.affected.conditions': ['environment', 'none'],
  'report.resultStatusSkipped': ['pending', 'skipped'],
  'coverage.thresholdGrouping': ['every-match', 'all-files'],
  'coverage.globThresholdScope': ['per-file', 'aggregate'],
  'coverage.v8Conversion': ['v8-to-istanbul', 'ast'],
  'hoist.placement': ['enclosing-block', 'top-level-only'],
  'hoist.reExports': ['in-order', 'static'],
  'hoist.rewrittenCalls': ['detached', 'member'],
}

/**
 * Keys whose `null` stands next to a type other than a string: what a flip of `null` becomes.
 * Every other `null` flips to a string.
 */
const NULL_FLIPS: Readonly<Record<string, unknown>> = {
  'core.eachTitleTruncate': 40,
  'snapshot.format.maxOutputLength': 1,
}

/**
 * Behaviour refs whose leaf flips to the neutral behaviour: a corpus that titles `.each` tests
 * must fail when the dialect's formatter is replaced by the neutral one, which is how the run
 * shows the ref is the runner's and not a stand-in (T5.4). Other refs have no flip: `own` pins them.
 */
const REF_FLIPS: Readonly<Record<string, readonly unknown[]>> = {
  'core.formatEachTitle': [neutralPolicy.core.formatEachTitle],
  'core.formatValue': [neutralPolicy.core.formatValue],
  // Core's own words for a timeout: Jest's recordings (`policy/core-timeouts`, `runtime/done-*`)
  // say `Exceeded timeout of …`, which `null` doesn't.
  'core.timeouts.message': [neutralPolicy.core.timeouts.message],
  // `--randomize --seed` on 30 tests: no shuffle keeps the declared order, which the recording isn't.
  'core.shuffle': [neutralPolicy.core.shuffle],
  // Core's own words for a fixture error: `runtime/fixture-parse-error` holds Vitest's.
  'core.definitions.messages': [neutralPolicy.core.definitions.messages],
  // The four `cli/global-setup-throws*` recordings word a failing hook as Jest's behaviour does; the
  // neutral wording must fail them (the claim calls the ref it is given).
  'orchestrator.globalSetup.failure': [neutralPolicy.orchestrator.globalSetup.failure],
  // The neutral values: no provider (`-o` refused) and the lexer, which reads a commented
  // `require` and misses `jest.requireActual` (`changed/related-extractor-*`).
  'orchestrator.changedFiles': [neutralPolicy.orchestrator.changedFiles],
  'orchestrator.affected.extractor': [neutralPolicy.orchestrator.affected.extractor],
  // The neutral `null` (`this.snapshotState` is Provino's own state, which has no `_counters` or
  // `match`), and two refs that name no view: another export of the dialect's module, and the
  // view's export name in another module (`ecosystem/image-snapshot-*`, `custom-snapshot-*`).
  'snapshot.contextView': [
    neutralPolicy.snapshot.contextView,
    { module: import.meta.resolve('@provino/dialect-jest/runtime'), export: 'jestSnapshotPrinter' },
    { module: import.meta.resolve('@provino/policy/behaviours'), export: 'jestSnapshotStateView' },
  ],
}

/** The suffix a flipped free-text value gains. */
export const FLIP_SUFFIX = ' (flipped)'

/**
 * The values a leaf's evidence must reject: every other value of an enumerated key, or one
 * differing value of the same type. `[]` for a value no flip applies to (a behaviour ref).
 */
export function flipsOf(path: string, value: unknown): readonly unknown[] {
  const domain = DOMAINS[path]
  if (domain !== undefined) return domain.filter((other) => other !== value)
  const refFlips = REF_FLIPS[path]
  if (refFlips !== undefined) return refFlips.filter((flip) => !isDeepStrictEqual(flip, value))
  if (typeof value === 'boolean') return [!value]
  if (typeof value === 'number') return [value + 1]
  // Both ends, so a check that reads only the first line or only the start of a text can't pass.
  if (typeof value === 'string') return [`flipped ${value}`, `${value}${FLIP_SUFFIX}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [['flipped']]
    const reversed = value.toReversed()
    return JSON.stringify(reversed) === JSON.stringify(value) ? [[]] : [reversed, []]
  }
  if (value === null) return [path in NULL_FLIPS ? NULL_FLIPS[path] : 'flipped']
  return []
}
