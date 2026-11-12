// G0's report built from fakes: one subject's row (the bars it must meet), the report over rows
// (the 30-rule limit, unused rules, added normalization rules) and the text. No runs, no disk.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExclusionRule } from '../diff.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import {
  BASELINE_NORMALIZATION_RULES,
  buildGateReport,
  formatGateReport,
  G0_MAX_EXCLUSION_RULES,
  MIN_REFERENCE_RUNS,
  type GateInput,
  type GateSubject,
  gateSubject,
} from './gate.ts'
import type { InstallRecord } from './install.ts'
import type { RunMeta } from './run.ts'
import { selfDiff } from './self-diff.ts'
import { makeRepo, makeSubject } from './test-support.ts'

const TODAY = '2026-11-12'

/** A run of `count` passing tests, with `override` titles given another status. */
function run(count: number, override: Record<string, 'failed' | 'skipped'> = {}) {
  return makeRun([
    makeFile(
      'src/a.test.js',
      Array.from({ length: count }, (_, i) =>
        makeTest('src/a.test.js', [`t${i}`], { status: override[`t${i}`] ?? 'passed' }),
      ),
    ),
  ])
}

function meta(n: number, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    repo: 'demo',
    subject: 'demo',
    n,
    startedAt: '2026-11-12T10:00:00.000Z',
    runner: 'jest',
    runnerVersion: '30.5.2',
    cloneMs: 10,
    prepareMs: 5,
    runMs: 1000 * n,
    exitCode: 0,
    tests: 100,
    files: 1,
    statuses: { passed: 100 },
    fired: [],
    sidecar: { files: 2, withConsole: 2, missing: [] },
    ...overrides,
  }
}

const OFFLINE = {
  ok: true,
  wallMs: 900,
  verifiedAt: '2026-11-12T09:30:00.000Z',
  fingerprint: 'f'.repeat(64),
}

const INSTALL: InstallRecord = {
  id: 'demo',
  sha: 'a'.repeat(40),
  packageManager: { name: 'npm', version: 'bundled with Node' },
  command: ['npm', 'ci'],
  wallMs: 4000,
  installedAt: '2026-11-12T09:00:00.000Z',
  fingerprint: 'f'.repeat(64),
  fingerprintFiles: 10,
  runnerVersions: { demo: '30.5.2' },
  offline: OFFLINE,
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  const runs = [run(100), run(100), run(100)]
  return {
    repo: makeRepo(),
    subject: makeSubject(),
    install: INSTALL,
    metas: [meta(1), meta(2), meta(3)],
    selfDiff: selfDiff(runs, { exclusions: [], flaky: [], today: TODAY }),
    flaky: [],
    exclusions: [],
    ...overrides,
  }
}

test('three identical runs, an offline re-install and a clean sidecar pass', () => {
  const row = gateSubject(input())
  assert.equal(row.pass, true)
  assert.deepEqual(row.problems, [])
  assert.equal(row.comparedTests, 100)
  assert.equal(row.installMs, 4000)
  assert.equal(row.offlineReinstall, 'ok')
  assert.equal(row.packageManager, 'npm')
  assert.deepEqual(
    row.selfDiffs.map((pair) => pair.pair),
    ['1-2', '1-3'],
  )
  assert.equal(row.runs.length, 3)
})

test('fewer than 3 runs, a changed runner version and a missing install record are problems', () => {
  const row = gateSubject(
    input({
      install: undefined,
      metas: [meta(1), meta(2, { runnerVersion: '30.5.3' })],
      selfDiff: selfDiff([run(100), run(100)], { exclusions: [], flaky: [], today: TODAY }),
    }),
  )
  assert.equal(row.pass, false)
  assert.ok(row.problems.includes('2 reference runs, 3 needed'))
  assert.ok(
    row.problems.some((problem) => problem.startsWith('runs used different runner versions')),
  )
  assert.ok(row.problems.includes('no install record'))
  assert.equal(row.offlineReinstall, 'not run')
})

test('an offline re-install that was never run, or failed, stops the subject passing', () => {
  const { offline: _offline, ...withoutOffline } = INSTALL
  const none = gateSubject(input({ install: withoutOffline }))
  assert.equal(none.pass, false)
  assert.equal(none.offlineReinstall, 'not run')
  const failed = gateSubject(
    input({
      install: { ...INSTALL, offline: { ...OFFLINE, ok: false } },
    }),
  )
  assert.equal(failed.pass, false)
  assert.equal(failed.offlineReinstall, 'failed')
})

test('flaky tests and rule-excluded tests together may be at most 2% of the reference (D65)', () => {
  const runs = [run(100), run(100, { t0: 'failed' }), run(100, { t1: 'skipped' })]
  const flaky = ['src/a.test.js::t0#0', 'src/a.test.js::t1#0', 'src/a.test.js::t2#0']
  const row = gateSubject(
    input({
      flaky,
      metas: [meta(1), meta(2), meta(3)],
      selfDiff: selfDiff(runs, { exclusions: [], flaky, today: TODAY }),
    }),
  )
  assert.equal(row.pass, false)
  assert.equal(row.flaky.count, 3)
  assert.equal(row.flaky.share, 0.03)
  assert.ok(
    row.problems.some((problem) =>
      /flaky \(3\) plus rule-excluded \(0\) tests are 3.00% of 100/.test(problem),
    ),
    row.problems.join('\n'),
  )
})

test('a flaky key the reference run lacks is not an excluded test (D65 reads counts.excluded)', () => {
  const runs = [run(100), run(100, { t0: 'skipped' }), run(100)]
  // 1 real flaky test and 2 keys from tests that are not in run 1: 1% of the reference, not 3%.
  const flaky = ['src/a.test.js::t0#0', 'src/gone.test.js::x#0', 'src/gone.test.js::y#0']
  const row = gateSubject(
    input({ flaky, selfDiff: selfDiff(runs, { exclusions: [], flaky, today: TODAY }) }),
  )
  assert.deepEqual(row.selfDiffs.flatMap((pair) => pair.reasons), [])
  assert.deepEqual(row.problems, [])
  assert.equal(row.pass, true)
})

test('the run count the gate needs is the one corpus run requires', () => {
  assert.equal(MIN_REFERENCE_RUNS, 3)
  const row = gateSubject(input({ metas: [meta(1), meta(2)] }))
  assert.ok(row.problems.includes(`2 reference runs, ${MIN_REFERENCE_RUNS} needed`))
})

test('a self-diff names the runs it compared by their numbers on disk', () => {
  const runs = [run(100), run(100), run(100)]
  const diff = selfDiff(runs, { exclusions: [], flaky: [], today: TODAY, numbers: [1, 3, 7] })
  assert.deepEqual(
    diff.pairs.map((pair) => pair.pair),
    [
      [1, 3],
      [1, 7],
    ],
  )
  const row = gateSubject(input({ selfDiff: diff }))
  assert.deepEqual(
    row.selfDiffs.map((pair) => pair.pair),
    ['1-3', '1-7'],
  )
})

test('rule exclusions are counted with the rules each self-diff used', () => {
  const rule: ExclusionRule = {
    id: 'div/t0',
    reason: 'a known difference',
    kinds: ['status'],
    keyGlob: 'src/a.test.js::t0#0',
    expires: '2026-12-01',
  }
  const unused: ExclusionRule = { ...rule, id: 'div/never', keyGlob: 'nothing' }
  const runs = [run(100), run(100, { t0: 'failed' }), run(100)]
  const row = gateSubject(
    input({
      exclusions: [rule, unused],
      selfDiff: selfDiff(runs, { exclusions: [rule, unused], flaky: [], today: TODAY }),
    }),
  )
  assert.equal(row.excluded.tests, 1)
  assert.equal(row.excluded.share, 0.01)
  assert.deepEqual(
    row.excluded.rules.map((r) => [r.id, r.used]),
    [
      ['div/t0', 1],
      ['div/never', 0],
    ],
  )
})

test('console output the sidecar saw and the run lacks is a problem, and a failing self-diff too', () => {
  const row = gateSubject(
    input({
      metas: [
        meta(1, {
          sidecar: { files: 3, withConsole: 1, missing: ['src/b.test.js', 'src/c.test.js'] },
        }),
        meta(2),
        meta(3),
      ],
      selfDiff: selfDiff([run(100), run(100, { t5: 'failed' }), run(100)], {
        exclusions: [],
        flaky: [],
        today: TODAY,
      }),
    }),
  )
  assert.equal(row.sidecar.ok, false)
  assert.equal(row.sidecar.filesWithOutput, 3)
  assert.deepEqual(row.sidecar.missing, ['src/b.test.js', 'src/c.test.js'])
  assert.ok(row.problems.includes('the sidecar saw console output the run lacks for 2 file(s)'))
  assert.ok(row.problems.includes('a self-diff fails'))
  assert.equal(row.pass, false)
})

test('the normalization rules that fired are counted by run', () => {
  const row = gateSubject(
    input({ metas: [meta(1, { fired: ['ansi', 'root'] }), meta(2, { fired: ['ansi'] }), meta(3)] }),
  )
  assert.deepEqual(row.normalizationFired, { ansi: 2, root: 1 })
})

/** A passing row with its own rules, for the report. */
function rowWithRules(subject: string, rules: { id: string; used: number }[]): GateSubject {
  const base = gateSubject(input())
  return {
    ...base,
    subject,
    excluded: { ...base.excluded, rules: rules.map((r) => ({ ...r, reason: 'because' })) },
  }
}

test('the report passes when rules are within 30, all used, and every subject passes', () => {
  const report = buildGateReport([rowWithRules('a', [{ id: 'r1', used: 1 }])], {
    today: TODAY,
    normalizationRules: [...BASELINE_NORMALIZATION_RULES],
  })
  assert.equal(report.pass, true)
  assert.equal(report.totals.exclusionRules, 1)
  assert.deepEqual(report.totals.normalizationRulesAdded, [])
  assert.ok(report.notCovered.length > 0)
})

test('more than 30 rules, an unused rule and a failing subject fail the report', () => {
  const many = Array.from({ length: G0_MAX_EXCLUSION_RULES + 1 }, (_, i) => ({
    id: `r${i}`,
    used: 1,
  }))
  const tooMany = buildGateReport([rowWithRules('a', many)], {
    today: TODAY,
    normalizationRules: [],
  })
  assert.equal(tooMany.pass, false)
  assert.match(tooMany.totals.problems.join('\n'), /31 exclusion rules, more than G0's 30/)
  const unused = buildGateReport([rowWithRules('a', [{ id: 'r1', used: 0 }])], {
    today: TODAY,
    normalizationRules: [],
  })
  assert.deepEqual(unused.totals.exclusionRulesUnused, ['a: r1'])
  assert.equal(unused.pass, false)
  const failing = buildGateReport(
    [{ ...rowWithRules('a', []), pass: false, problems: ['x broke'] }],
    {
      today: TODAY,
      normalizationRules: [],
    },
  )
  assert.match(failing.totals.problems.join('\n'), /a: x broke/)
})

test('a normalization rule beyond the nine B15 shipped is listed as added', () => {
  const report = buildGateReport([rowWithRules('a', [])], {
    today: TODAY,
    normalizationRules: [...BASELINE_NORMALIZATION_RULES, 'pid'],
  })
  assert.deepEqual(report.totals.normalizationRulesAdded, ['pid'])
})

test('the largest flaky share names its subject', () => {
  const a = rowWithRules('a', [])
  const b = { ...rowWithRules('b', []), flaky: { count: 2, share: 0.015 } }
  const report = buildGateReport([a, b], { today: TODAY, normalizationRules: [] })
  assert.deepEqual(report.totals.largestFlakyShare, { subject: 'b', share: 0.015 })
  assert.equal(
    buildGateReport([], { today: TODAY, normalizationRules: [] }).totals.largestFlakyShare,
    undefined,
  )
})

test('the text report says PASS or FAIL per subject and overall, with every time labelled local', () => {
  const pass = buildGateReport([rowWithRules('a', [{ id: 'r1', used: 2 }])], {
    today: TODAY,
    normalizationRules: [],
  })
  const text = formatGateReport(pass)
  assert.match(text, /^G0 gate report \(2026-11-12\); all timings are `local`/)
  assert.match(text, /^a: PASS$/m)
  assert.match(text, /install 4\.0 s; offline re-install ok/)
  assert.match(text, /run 1: T 100 \(passed 100\); 1\.0 s, prepare 0\.0 s/)
  assert.match(text, /rule r1 used 2: because/)
  assert.match(
    text,
    /self-diff 1-2: status 100%, message 100%, snapshot 100%, suite pass yes, unexplained diffs 0$/m,
  )
  assert.match(text, /G0 on the pilot: PASS\n$/)
  const failing = buildGateReport(
    [{ ...rowWithRules('a', []), pass: false, problems: ['no install record'] }],
    {
      today: TODAY,
      normalizationRules: [],
    },
  )
  const failText = formatGateReport(failing)
  assert.match(failText, /^a: FAIL$/m)
  assert.match(failText, /problem: no install record/)
  assert.match(failText, /G0 on the pilot: FAIL\n$/)
  assert.doesNotMatch(text, /provino \d/i, 'the report holds no Provino number')
})
