// T12.10's analysis pieces on built runs, no runner: the flaky list, the self-diff and the extractor's
// left-out set.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExclusionRule } from '../diff.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { flakyKeys } from './flaky.ts'
import { isLeftOut, LEFT_OUT_PATTERNS } from './left-out.ts'
import { selfDiff } from './self-diff.ts'

const TODAY = '2026-11-08'

function run(
  statuses: Record<string, 'passed' | 'failed' | 'skipped'>,
  fileStatus = 'passed' as const,
) {
  return makeRun([
    makeFile(
      'src/a.test.ts',
      Object.entries(statuses).map(([title, status]) =>
        makeTest('src/a.test.ts', ['s', title], { status }),
      ),
      fileStatus,
    ),
  ])
}

test('a test whose status differs between any two runs is flaky, and so is one a run lacks', () => {
  const runs = [
    run({ steady: 'passed', flips: 'passed', gone: 'passed' }),
    run({ steady: 'passed', flips: 'failed', gone: 'passed' }),
    run({ steady: 'passed', flips: 'passed' }),
  ]
  assert.deepEqual(flakyKeys(runs), ['src/a.test.ts::s › flips#0', 'src/a.test.ts::s › gone#0'])
  assert.deepEqual(flakyKeys([runs[0] ?? run({})]), [])
  assert.deepEqual(flakyKeys([]), [])
})

test('three identical runs self-diff clean, in both pairs', () => {
  const runs = [
    run({ a: 'passed', b: 'failed' }),
    run({ a: 'passed', b: 'failed' }),
    run({ a: 'passed', b: 'failed' }),
  ]
  const result = selfDiff(runs, { exclusions: [], flaky: [], today: TODAY })
  assert.equal(result.pass, true)
  assert.deepEqual(
    result.pairs.map((pair) => pair.pair),
    [
      [1, 2],
      [1, 3],
    ],
  )
  for (const { report } of result.pairs) {
    assert.equal(report.statusParity, 1)
    assert.equal(report.messageParity, 1)
    assert.equal(report.snapshotByteParity, 1)
    assert.equal(report.suitePass, true)
    assert.equal(report.diffs.length, 0)
  }
})

test('a status change fails the self-diff until the flaky list names the test', () => {
  const runs = [
    run({ a: 'passed', b: 'passed' }),
    run({ a: 'passed', b: 'failed' }),
    run({ a: 'passed', b: 'passed' }),
  ]
  const bare = selfDiff(runs, { exclusions: [], flaky: [], today: TODAY })
  assert.equal(bare.pass, false)
  assert.equal(bare.pairs[0]?.pass, false)
  assert.match(bare.pairs[0]?.reasons.join('\n') ?? '', /status parity|diffs no rule explains/)
  assert.equal(bare.pairs[1]?.pass, true)
  const listed = selfDiff(runs, { exclusions: [], flaky: flakyKeys(runs), today: TODAY })
  assert.equal(listed.pass, true)
  assert.equal(listed.pairs[0]?.report.counts.flaky, 1)
})

test('a flaky test that flips its file keeps a file-status diff: flaky leaves T, never the file', () => {
  const runs = [
    run({ a: 'passed', b: 'passed' }),
    run({ a: 'passed', b: 'failed' }, 'failed' as never),
  ]
  const result = selfDiff(runs, { exclusions: [], flaky: flakyKeys(runs), today: TODAY })
  assert.equal(result.pass, false)
  assert.equal(result.pairs[0]?.report.suitePass, false)
  assert.deepEqual(
    result.pairs[0]?.report.diffs.map((diff) => diff.kind),
    ['file-status'],
  )
})

test('R2 caps the tests an exclusion rule may remove, with no calibration to lift it', () => {
  const rule: ExclusionRule = {
    id: 'x/status',
    reason: 'a test that fails the same way every time',
    kinds: ['status'],
    keyGlob: '*',
    expires: '2026-12-01',
  }
  const runs = [run({ a: 'passed', b: 'passed' }), run({ a: 'failed', b: 'passed' })]
  const result = selfDiff(runs, { exclusions: [rule], flaky: [], today: TODAY })
  // One of two tests removed is 50% of T, over R2's 2%.
  assert.equal(result.pass, false)
  assert.match(result.pairs[0]?.reasons.join('\n') ?? '', /--max-excluded/)
})

test('a self-diff needs at least two runs', () => {
  assert.equal(selfDiff([], { exclusions: [], flaky: [], today: TODAY }).pass, false)
  assert.equal(
    selfDiff([run({ a: 'passed' })], { exclusions: [], flaky: [], today: TODAY }).pass,
    false,
  )
})

test('the extractor leaves out the paths the agent sandbox cannot write', () => {
  for (const left of [
    '.env',
    'app/.env',
    'x/.env.local',
    'x/.env.test.local',
    '.vscode/settings.json',
    'a/.vscode/launch.json',
    '.idea/codeStyles/x.xml',
    '.mcp.json',
    '.gitmodules',
    'node_modules/y/.gitconfig',
  ]) {
    assert.equal(isLeftOut(left), true, left)
  }
  for (const kept of [
    '.env.example',
    'src/environment.ts',
    '.github/workflows/ci.yml',
    '.eslintrc.json',
    'vscode/x.ts',
    'src/.idea.ts',
  ]) {
    assert.equal(isLeftOut(kept), false, kept)
  }
  assert.ok(LEFT_OUT_PATTERNS.every((pattern) => pattern.startsWith('*/')))
})
