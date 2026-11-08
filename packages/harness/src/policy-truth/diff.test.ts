// T1.8's check: `policy-diff jest vitest` prints every divergence row of Track 1's policy table
// (L178-L234, "Policy surface"). Each row is mapped to the key it is today (§6's renames,
// `Dialect.loader.hoist` for the hoisting rows). A row the dialects no longer differ on is named
// with the reason, so nothing drops out unnoticed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dialectDiff, formatDialectDiff } from './diff.ts'

/** Track 1's rows where Jest 30.5 and Vitest 5.0 differ, as the keys that hold them now. */
const TRACK_1_DIVERGENCES: readonly string[] = [
  'core.hookOrder.afterEach',
  'core.hookOrder.afterAll',
  'core.eachHooksForConcurrent',
  'core.firstArg',
  'core.allowGeneratorFns',
  'core.timeouts.hook',
  'core.timeouts.teardown',
  'core.nameSeparator',
  'core.testNamePatternFlags',
  'core.missingTestFn',
  'core.asyncDescribe',
  'core.nonPromiseReturn',
  'core.eachTitleTruncate',
  'core.retry.timing',
  'core.allowOnly',
  'core.unawaitedAsyncAssertion',
  'core.hookReturnsCleanup',
  'mock.resetTo',
  'mock.defaultName',
  'mock.between.clear',
  'mock.classMockPrototype',
  'timers.toFakeDefault',
  'timers.loopLimit',
  'timers.legacyAvailable',
  'module.factoryShape',
  // `rootMocksDir`, renamed by §6's fact-check.
  'module.rootMocksAutoApply',
  'module.actual',
  // `nonTopLevelMock` and `hoistNames` are the hoisting rules' now (B03).
  'hoist.placement',
  'hoist.objects',
  'snapshot.header',
  // `key`'s difference is its separator: one `snapshotKey` with each dialect's join.
  'snapshot.keyJoin',
  'snapshot.obsolete.failLocal',
  'expect.matcherNamespace',
  'orchestrator.include',
  'orchestrator.bail.checkAfter',
  'orchestrator.watchDefault',
  'orchestrator.coverageProvider',
  'orchestrator.coverageReporters',
  'orchestrator.slowTestThresholdMs',
  'report.displaySeparator',
  'report.failureTitleBullet',
]

/** Track 1's divergence rows the dialects don't differ on today, each with its reason. */
const NOT_DIFFERING: Readonly<Record<string, string>> = {
  'core.formatEachTitle': 'both are the neutral formatter until T5.4 (B17a) builds each runner`s',
  'timers.fakeTemporal': 'Jest`s "via sinon 15.4" is pending for T4.9 (B17a)',
  'expect.pollFailsOnTimeout': 'Jest has no expect.poll, so its value is inert (T1.7)',
  'orchestrator.isolationDefault': 'D6 gives Jest registry, Track 1`s realm notwithstanding',
}

test('every divergence row of Track 1`s table is a row of policy-diff jest vitest', () => {
  const rows = new Set(dialectDiff('jest', 'vitest').map((row) => row.path))
  const missing = TRACK_1_DIVERGENCES.filter(
    (path) => !rows.has(path) && ![...rows].some((row) => row.startsWith(`${path}.`)),
  )
  assert.deepEqual(missing, [])
})

test('the rows that no longer differ are the named ones, and they really don`t', () => {
  const rows = dialectDiff('jest', 'vitest').map((row) => row.path)
  for (const path of Object.keys(NOT_DIFFERING)) {
    assert.ok(!rows.some((row) => row === path || row.startsWith(`${path}.`)), path)
  }
})

test('the diff runs both ways, and the table names both dialects and counts its rows', () => {
  const forward = dialectDiff('jest', 'vitest')
  const backward = dialectDiff('vitest', 'jest')
  assert.deepEqual(
    backward.map((row) => ({ path: row.path, a: row.b, b: row.a })),
    forward,
  )
  assert.deepEqual(dialectDiff('jest', 'jest'), [])
  const table = formatDialectDiff('jest', 'vitest').split('\n')
  assert.match(table[0] ?? '', /^key\s+jest\s+vitest$/)
  assert.equal(table.at(-1), `${forward.length} keys differ`)
  assert.ok(table.some((line) => /^core\.nameSeparator\s+' '\s+' > '$/.test(line)))
  assert.ok(
    table.every((line) => line.length < 220),
    'long values are cut',
  )
})
