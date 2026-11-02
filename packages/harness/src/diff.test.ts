import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NormalizedError, NormalizedRun } from '@provino/types'
import { type DiffOptions, diffRuns, type ExclusionRule } from './diff.ts'
import { HarnessError } from './errors.ts'
import { makeFile, makeRun, makeTest } from './test-support.ts'

const TODAY = '2026-11-02'

function options(overrides: Partial<DiffOptions> = {}): DiffOptions {
  return {
    messageMode: 'exact',
    compareConsole: false,
    compareTrace: false,
    exclusions: [],
    ...overrides,
  }
}

function error(message: string, extra: Partial<NormalizedError> = {}): NormalizedError {
  return { message, userFrame: '<root>/a.test.ts:3:4', raw: message, ...extra }
}

const FILE = 'a.test.ts'

function runWith(
  tests: ReturnType<typeof makeTest>[],
  overrides: Partial<NormalizedRun> = {},
): NormalizedRun {
  return makeRun([makeFile(FILE, tests)], overrides)
}

test('identical runs are fully at parity', () => {
  const run = runWith([
    makeTest(FILE, ['a']),
    makeTest(FILE, ['b'], { status: 'failed', errors: [error('x')] }),
  ])
  const report = diffRuns(run, run, options(), TODAY)
  assert.equal(report.statusParity, 1)
  assert.equal(report.messageParity, 1)
  assert.equal(report.snapshotByteParity, 1)
  assert.equal(report.suitePass, true)
  assert.deepEqual(report.diffs, [])
  assert.deepEqual(report.excluded, [])
  assert.deepEqual(report.expiredExclusions, [])
  assert.equal(report.counts.referenceTests, 2)
  assert.equal(report.counts.comparedTests, 2)
  assert.equal(report.counts.failedInBoth, 1)
})

test('a status mismatch is a diff and lowers status parity', () => {
  const ref = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['b'])])
  const cand = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['b'], { status: 'skipped' })])
  const report = diffRuns(ref, cand, options(), TODAY)
  assert.equal(report.statusParity, 0.5)
  assert.deepEqual(report.diffs, [
    { key: 'a.test.ts::b#0', kind: 'status', ref: 'passed', cand: 'skipped' },
  ])
})

test('a test the candidate lacks is a mismatch; a test only it has is reported, not counted', () => {
  const ref = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['gone'])])
  const cand = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['extra'])])
  const report = diffRuns(ref, cand, options(), TODAY)
  assert.equal(report.statusParity, 0.5)
  assert.equal(report.counts.comparedTests, 2)
  assert.equal(report.counts.candidateOnlyTests, 1)
  assert.deepEqual(report.diffs, [
    { key: 'a.test.ts::extra#0', kind: 'missing-in-reference', cand: 'passed' },
    { key: 'a.test.ts::gone#0', kind: 'missing-in-candidate', ref: 'passed' },
  ])
})

test('file status is compared; a file in one run only breaks suitePass', () => {
  const ref = makeRun([
    makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])]),
    makeFile('b.test.ts', []),
  ])
  const cand = makeRun([
    makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])], 'failed'),
    makeFile('c.test.ts', []),
  ])
  const report = diffRuns(ref, cand, options(), TODAY)
  assert.equal(report.suitePass, false)
  assert.deepEqual(
    report.diffs.map((d) => [d.key, d.kind, d.ref, d.cand]),
    [
      ['a.test.ts', 'file-status', 'passed', 'failed'],
      ['b.test.ts', 'file-status', 'passed', 'missing'],
      ['c.test.ts', 'file-status', 'missing', 'passed'],
    ],
  )
  assert.equal(report.counts.files, 3)
  assert.equal(report.counts.filesMatched, 0)
})

const failedRef = runWith([
  makeTest(FILE, ['t'], {
    status: 'failed',
    errors: [error('expected 1 to be 2', { matcher: 'toBe' })],
  }),
])
const failedCand = runWith(
  [
    makeTest(FILE, ['t'], {
      status: 'failed',
      errors: [error('Expected: 2, Received: 1', { matcher: 'toBe' })],
    }),
  ],
  { runner: 'provino:jest' },
)

test('exact mode compares the message and the user frame of each error', () => {
  const report = diffRuns(failedRef, failedCand, options({ messageMode: 'exact' }), TODAY)
  assert.equal(report.messageParity, 0)
  assert.equal(report.statusParity, 1)
  assert.deepEqual(report.diffs, [
    {
      key: 'a.test.ts::t#0',
      kind: 'message',
      ref: 'expected 1 to be 2',
      cand: 'Expected: 2, Received: 1',
      index: 0,
    },
  ])
})

test('matcher mode ignores the message text and compares the matcher and the user frame', () => {
  const same = diffRuns(failedRef, failedCand, options({ messageMode: 'matcher' }), TODAY)
  assert.equal(same.messageParity, 1)
  assert.deepEqual(same.diffs, [])

  const other = runWith(
    [
      makeTest(FILE, ['t'], {
        status: 'failed',
        errors: [error('x', { matcher: 'toEqual', userFrame: '<root>/a.test.ts:9:9' })],
      }),
    ],
    { runner: 'provino:jest' },
  )
  const report = diffRuns(failedRef, other, options({ messageMode: 'matcher' }), TODAY)
  assert.deepEqual(
    report.diffs.map((d) => d.kind),
    ['matcher', 'user-frame'],
  )
})

test('matcher mode tolerates a runner that names no matcher', () => {
  const noMatcher = runWith(
    [makeTest(FILE, ['t'], { status: 'failed', errors: [error('expected 1 to be 2')] })],
    { runner: 'vitest' },
  )
  const report = diffRuns(failedRef, noMatcher, options({ messageMode: 'matcher' }), TODAY)
  assert.deepEqual(report.diffs, [])
})

test('none mode compares only the error count', () => {
  const two = runWith([
    makeTest(FILE, ['t'], { status: 'failed', errors: [error('a'), error('b')] }),
  ])
  const report = diffRuns(failedRef, two, options({ messageMode: 'none' }), TODAY)
  assert.deepEqual(report.diffs, [
    { key: 'a.test.ts::t#0', kind: 'error-count', ref: '1', cand: '2' },
  ])
  assert.equal(report.messageParity, 0)
  assert.deepEqual(
    diffRuns(failedRef, failedCand, options({ messageMode: 'none' }), TODAY).diffs,
    [],
  )
})

test('passing-assertion counts are compared only when both runs have one', () => {
  const ref = runWith([
    makeTest(FILE, ['a'], { passingAssertions: 2 }),
    makeTest(FILE, ['b'], { passingAssertions: 1 }),
  ])
  const cand = runWith([makeTest(FILE, ['a'], { passingAssertions: 3 }), makeTest(FILE, ['b'])])
  const report = diffRuns(ref, cand, options(), TODAY)
  assert.deepEqual(report.diffs, [
    { key: 'a.test.ts::a#0', kind: 'passing-assertions', ref: '2', cand: '3' },
  ])
})

test('durations are never compared', () => {
  const ref = runWith([{ ...makeTest(FILE, ['a']), durationMs: 1 }])
  const cand = runWith([{ ...makeTest(FILE, ['a']), durationMs: 900 }])
  assert.deepEqual(diffRuns(ref, cand, options(), TODAY).diffs, [])
})

test('an exclusion moves its diffs out of the failing list and out of the denominators', () => {
  const rule: ExclusionRule = {
    id: 'X1',
    reason: 'message text differs by design',
    kinds: ['message'],
    keyGlob: 'a.test.ts::t*',
    pair: ['jest', 'provino:jest'],
    expires: '2027-01-01',
  }
  const report = diffRuns(failedRef, failedCand, options({ exclusions: [rule] }), TODAY)
  assert.deepEqual(report.diffs, [])
  assert.deepEqual(
    report.excluded.map((d) => [d.key, d.kind, d.ruleId]),
    [['a.test.ts::t#0', 'message', 'X1']],
  )
  assert.equal(report.messageParity, 1)
  assert.equal(report.counts.failedInBoth, 0)
  assert.equal(report.counts.excluded, 0, 'a message exclusion does not remove the test from T')
  assert.equal(report.counts.comparedTests, 1)
})

test('an exclusion covers only the kinds, keys and runner pair it names', () => {
  const base = { id: 'X', reason: 'r', kinds: ['message'] as const }
  const apply = (rule: ExclusionRule) =>
    diffRuns(failedRef, failedCand, options({ exclusions: [rule] }), TODAY).diffs.length
  assert.equal(apply({ ...base, kinds: ['status'] }), 1, 'wrong kind')
  assert.equal(apply({ ...base, keyGlob: 'other.test.ts::*' }), 1, 'wrong key')
  assert.equal(apply({ ...base, pair: ['vitest', 'provino:vitest'] }), 1, 'wrong pair')
  assert.equal(apply({ ...base }), 0, 'no glob and no pair matches everything')
})

test('an excluded message diff does not hide a status diff on the same test', () => {
  const ref = runWith([makeTest(FILE, ['t'], { status: 'failed', errors: [error('a')] })])
  const cand = runWith([makeTest(FILE, ['t'])])
  const report = diffRuns(
    ref,
    cand,
    options({ exclusions: [{ id: 'X', reason: 'r', kinds: ['message'] }] }),
    TODAY,
  )
  assert.deepEqual(
    report.diffs.map((d) => d.kind),
    ['file-status', 'status'],
  )
  assert.equal(report.statusParity, 0)
})

test('an expired exclusion excludes nothing and is reported; the expiry day itself still counts', () => {
  const rule: ExclusionRule = { id: 'OLD', reason: 'r', kinds: ['message'], expires: '2026-11-01' }
  const expired = diffRuns(failedRef, failedCand, options({ exclusions: [rule] }), TODAY)
  assert.equal(expired.diffs.length, 1)
  assert.deepEqual(expired.expiredExclusions, [{ id: 'OLD', expires: '2026-11-01' }])
  assert.deepEqual(expired.excluded, [])

  const lastDay = diffRuns(
    failedRef,
    failedCand,
    options({ exclusions: [{ ...rule, expires: TODAY }] }),
    TODAY,
  )
  assert.deepEqual(lastDay.diffs, [])
  assert.deepEqual(lastDay.expiredExclusions, [])
})

test('a malformed date is a coded error', () => {
  const bad = (call: () => unknown) =>
    assert.throws(call, (e: unknown) => e instanceof HarnessError && e.code === 'HARNESS_BAD_DATE')
  bad(() => diffRuns(failedRef, failedRef, options(), '11/02/2026'))
  bad(() =>
    diffRuns(
      failedRef,
      failedRef,
      options({ exclusions: [{ id: 'X', reason: 'r', kinds: [], expires: 'soon' }] }),
      TODAY,
    ),
  )
})

test('snapshot byte parity compares sha256 per file', () => {
  const snapshots = (files: [string, string][]) => ({
    snapshots: {
      counters: {
        added: 0,
        matched: 0,
        unmatched: 0,
        updated: 0,
        unchecked: 0,
        total: 0,
        filesAdded: 0,
        filesRemoved: 0,
        filesUnmatched: 0,
        filesUpdated: 0,
      },
      files: files.map(([file, sha256]) => ({ file, sha256 })),
    },
  })
  const ref = runWith(
    [],
    snapshots([
      ['a.snap', '11'],
      ['b.snap', '22'],
      ['c.snap', '33'],
    ]),
  )
  const cand = runWith(
    [],
    snapshots([
      ['a.snap', '11'],
      ['b.snap', '99'],
      ['d.snap', '44'],
    ]),
  )
  const report = diffRuns(ref, cand, options(), TODAY)
  assert.equal(report.snapshotByteParity, 1 / 3)
  assert.deepEqual(
    report.diffs.map((d) => [d.key, d.ref, d.cand]),
    [
      ['b.snap', '22', '99'],
      ['c.snap', '33', undefined],
      ['d.snap', undefined, '44'],
    ],
  )
  assert.equal(report.counts.snapshotFiles, 3)
})

test('console is compared only on request: per test when both attribute it, else per file', () => {
  const line = (text: string) => ({ stream: 'stdout' as const, text })
  const ref = runWith([makeTest(FILE, ['a'], { console: [line('one')] }), makeTest(FILE, ['b'])])
  const cand = runWith([makeTest(FILE, ['a'], { console: [line('two')] }), makeTest(FILE, ['b'])])
  assert.deepEqual(diffRuns(ref, cand, options(), TODAY).diffs, [])
  const on = diffRuns(ref, cand, options({ compareConsole: true }), TODAY)
  assert.deepEqual(
    on.diffs.map((d) => [d.key, d.kind]),
    [['a.test.ts::a#0', 'console']],
  )

  const unattributed = makeRun([
    { ...makeFile(FILE, [makeTest(FILE, ['a'])]), console: [line('b'), line('a')] },
  ])
  const attributedElsewhere = makeRun([
    { ...makeFile(FILE, [makeTest(FILE, ['a'])]), console: [line('a'), line('b')] },
  ])
  assert.deepEqual(
    diffRuns(unattributed, attributedElsewhere, options({ compareConsole: true }), TODAY).diffs,
    [],
    'the same lines in another order are equal when nothing is attributed',
  )
})

test('the hook trace is compared only on request', () => {
  const trace = (...owners: string[]) =>
    makeRun([
      {
        ...makeFile(FILE, [makeTest(FILE, ['a'])]),
        trace: owners.map((o) => ({ kind: 'hook:beforeEach' as const, owner: [o] })),
      },
    ])
  const ref = trace('x', 'y')
  const cand = trace('y', 'x')
  assert.deepEqual(diffRuns(ref, cand, options(), TODAY).diffs, [])
  assert.deepEqual(
    diffRuns(ref, cand, options({ compareTrace: true }), TODAY).diffs.map((d) => d.kind),
    ['trace'],
  )
})

test('the report names both runs and the mode', () => {
  const report = diffRuns(failedRef, failedCand, options({ messageMode: 'matcher' }), TODAY)
  assert.deepEqual(report.reference, {
    runner: 'jest',
    runnerVersion: '30.5.2',
    suite: 'unit/suite',
  })
  assert.equal(report.candidate.runner, 'provino:jest')
  assert.equal(report.messageMode, 'matcher')
})

test('parities are 1 when there is nothing to compare', () => {
  const report = diffRuns(makeRun([]), makeRun([]), options(), TODAY)
  assert.deepEqual(
    [report.statusParity, report.messageParity, report.snapshotByteParity, report.suitePass],
    [1, 1, 1, true],
  )
  assert.equal(report.counts.comparedTests, 0)
})

test('an excluded message diff does not hide a user-frame diff on the same test', () => {
  const ref = runWith([
    makeTest(FILE, ['t'], {
      status: 'failed',
      errors: [error('a', { userFrame: '<root>/a.test.ts:3:4' })],
    }),
  ])
  const cand = runWith([
    makeTest(FILE, ['t'], {
      status: 'failed',
      errors: [error('b', { userFrame: '<root>/a.test.ts:9:9' })],
    }),
  ])
  const report = diffRuns(
    ref,
    cand,
    options({ exclusions: [{ id: 'X', reason: 'r', kinds: ['message'] }] }),
    TODAY,
  )
  assert.deepEqual(
    report.diffs.map((d) => d.kind),
    ['user-frame'],
  )
  assert.deepEqual(
    report.excluded.map((d) => d.kind),
    ['message'],
  )
  assert.equal(report.counts.failedInBoth, 1)
  assert.equal(report.counts.messageMatched, 0)
  assert.equal(report.messageParity, 0)
})

test('with two errors, an excluded message diff on one does not hide a failing diff on the other', () => {
  const ref = runWith([
    makeTest(FILE, ['t'], { status: 'failed', errors: [error('a0'), error('a1')] }),
  ])
  const cand = runWith([
    makeTest(FILE, ['t'], {
      status: 'failed',
      errors: [error('b0'), error('a1', { userFrame: '<root>/a.test.ts:9:9' })],
    }),
  ])
  const report = diffRuns(
    ref,
    cand,
    options({ exclusions: [{ id: 'X', reason: 'r', kinds: ['message'] }] }),
    TODAY,
  )
  assert.deepEqual(
    report.diffs.map((d) => [d.kind, d.index]),
    [['user-frame', 1]],
  )
  assert.equal(report.counts.failedInBoth, 1)
  assert.equal(report.messageParity, 0)
})

test('when every message-family diff of a test is excluded, the test leaves F', () => {
  const ref = runWith([
    makeTest(FILE, ['t'], { status: 'failed', errors: [error('a0'), error('a1')] }),
  ])
  const cand = runWith([
    makeTest(FILE, ['t'], { status: 'failed', errors: [error('b0'), error('b1')] }),
  ])
  const report = diffRuns(
    ref,
    cand,
    options({ exclusions: [{ id: 'X', reason: 'r', kinds: ['message'] }] }),
    TODAY,
  )
  assert.deepEqual(report.diffs, [])
  assert.equal(report.counts.failedInBoth, 0)
  assert.equal(report.messageParity, 1)
})

test('two tests with one key in a run are a coded error naming the key and the run', () => {
  const dup = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['a'])])
  const duplicate = (side: string) => (e: unknown) =>
    e instanceof HarnessError &&
    e.code === 'HARNESS_DUPLICATE_TEST_KEY' &&
    e.message.includes('a.test.ts::a#0') &&
    e.message.includes(side)
  assert.throws(() => diffRuns(dup, runWith([]), options(), TODAY), duplicate('reference'))
  assert.throws(() => diffRuns(runWith([]), dup, options(), TODAY), duplicate('candidate'))
})

test('counts.excluded is the number of reference tests an exclusion removed from T', () => {
  const ref = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['b']), makeTest(FILE, ['gone'])])
  const cand = runWith([makeTest(FILE, ['a']), makeTest(FILE, ['b'], { status: 'skipped' })])
  const report = diffRuns(
    ref,
    cand,
    options({
      exclusions: [
        { id: 'S', reason: 'r', kinds: ['status'], keyGlob: '*::b#*' },
        { id: 'M', reason: 'r', kinds: ['missing-in-candidate'], keyGlob: '*::gone#*' },
      ],
    }),
    TODAY,
  )
  assert.equal(report.counts.referenceTests, 3)
  assert.equal(report.counts.comparedTests, 1)
  assert.equal(report.counts.excluded, 2)
})
