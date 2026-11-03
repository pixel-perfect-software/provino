import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRecord, BenchResult, BenchSubject, RunEnvironment } from '@provino/types'
import { code } from './internal/test-helpers.ts'
import {
  BENCH_LABELS,
  buildRecord,
  defaultMachineId,
  defaultOutPath,
  formatSummary,
  LABEL_POLICY,
  parseLabel,
  requireCleanTree,
  runsProblem,
} from './report.ts'
import { wallStats } from './stats.ts'

const environment: RunEnvironment = {
  os: 'darwin',
  osRelease: '27.2.0',
  arch: 'arm64',
  cpuModel: 'Test CPU',
  cpuCount: 8,
  memoryMb: 16384,
  node: 'v24.0.0',
  runners: { jest: '30.5.2', vitest: '5.0.5' },
  ci: false,
}

function result(
  runner: 'jest' | 'vitest',
  cache: 'warm' | 'cold',
  samples: number[],
  extra: Partial<BenchResult> = {},
): BenchResult {
  const subject: BenchSubject = {
    runner,
    version: runner === 'jest' ? '30.5.2' : '5.0.5',
    isolation: 'runner-default',
    command: `run ${runner}`,
  }
  return { benchId: 'app-50', subject, cache, wall: wallStats(samples), ok: true, ...extra }
}

function record(results: BenchResult[], label: BenchRecord['label'] = 'local'): BenchRecord {
  return buildRecord({
    label,
    ref: { sha: 'a'.repeat(40), date: '2026-11-02T10:00:00.000Z', dirty: false },
    environment,
    machineId: `${label}-darwin-arm64`,
    results,
  })
}

test('labels are local, desktop or pinned, and nothing else', () => {
  assert.equal(parseLabel('local'), 'local')
  assert.equal(parseLabel('desktop'), 'desktop')
  assert.equal(parseLabel('pinned'), 'pinned')
  for (const bad of ['', 'Local', 'ci', 'production']) {
    assert.throws(() => parseLabel(bad), code('BENCH_USAGE'))
  }
})

test('the default machine id is label, platform and arch, never a hostname', () => {
  assert.equal(
    defaultMachineId('local', { platform: 'darwin', arch: 'arm64' }),
    'local-darwin-arm64',
  )
  assert.equal(defaultMachineId('pinned', { platform: 'linux', arch: 'x64' }), 'pinned-linux-x64')
})

test('the default output is stamped to the second and named for the suite and commit', () => {
  const ref = { sha: `abc1234${'0'.repeat(33)}`, date: '2026-11-02T10:11:12.345Z', dirty: false }
  assert.equal(
    defaultOutPath(ref, 'app-500', '/out'),
    '/out/2026-11-02T10-11-12Z-app-500-abc1234.json',
  )
  // Two runs on the same day never share a path.
  const later = { ...ref, date: '2026-11-02T10:11:13.000Z' }
  assert.notEqual(defaultOutPath(later, 'app-500', '/out'), defaultOutPath(ref, 'app-500', '/out'))
})

test('a record carries the schema version, label, ref, machine and results', () => {
  const built = record([runs('jest', 'warm', 10)], 'desktop')
  assert.equal(built.schemaVersion, 1)
  assert.equal(built.label, 'desktop')
  assert.equal(built.machine.id, 'desktop-darwin-arm64')
  assert.equal(built.machine.cpuModel, 'Test CPU')
  assert.deepEqual(built.machine.runners, { jest: '30.5.2', vitest: '5.0.5' })
  assert.equal(built.results.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built)
})

test('every line of the summary shows the label', () => {
  const text = formatSummary(
    record([
      result('jest', 'warm', [100, 102, 98], { peakRssMb: 180.5, cpuUserMs: 3000, cpuSysMs: 900 }),
      result('vitest', 'warm', [200, 204, 196]),
    ]),
  )
  const lines = text.split('\n')
  assert.ok(lines.length >= 5)
  assert.ok(
    lines.every((line) => line.startsWith('[local] ')),
    text,
  )
  assert.match(text, /jest 30\.5\.2\s+warm\s+3\s+100\.0/)
  assert.match(text, /180\.5/)
  assert.match(text, /3000\/900/)
  assert.match(text, /n\/a/)
  assert.match(text, /development signal only/)
})

test('other runners get a median ratio against Jest with a CI', () => {
  const text = formatSummary(
    record([result('jest', 'warm', [100, 100, 100]), result('vitest', 'warm', [200, 200, 200])]),
  )
  assert.match(text, /app-50 vitest\/jest warm: median ratio 2\.000 \(95% CI 2\.000-2\.000\)/)
})

test('a failing run is flagged and gets no ratio', () => {
  const text = formatSummary(
    record([result('jest', 'warm', [100, 100]), result('vitest', 'warm', [50, 50], { ok: false })]),
  )
  assert.match(text, /vitest\/jest warm: no ratio, a run failed/)
  assert.match(text, /WARNING: vitest warm had a failing run/)
  assert.match(text, /\bNO\b/)
})

test('the footer says what the label means', () => {
  for (const label of BENCH_LABELS) {
    assert.match(
      formatSummary(record([runs('jest', 'warm', 10)], label)),
      new RegExp(`\\[${label}\\] label ${label}: ${LABEL_POLICY[label].note}`),
    )
  }
  assert.match(
    formatSummary(record([runs('jest', 'warm', 10)], 'desktop')),
    /\[desktop\] .*provisional/,
  )
  assert.match(
    formatSummary(record([runs('jest', 'warm', 10)], 'pinned')),
    /\[pinned\] .*dedicated/,
  )
})

function runs(runner: 'jest' | 'vitest', cache: 'warm' | 'cold', count: number): BenchResult {
  return result(
    runner,
    cache,
    Array.from({ length: count }, (_, index) => 100 + index),
  )
}

test('a summary of fewer runs than the R5 protocol warns, whatever the label', () => {
  const warning = /\[local\] WARNING: fewer runs than the R5 protocol \(10 warm, 5 cold\)/
  assert.match(formatSummary(record([runs('jest', 'warm', 9), runs('jest', 'cold', 5)])), warning)
  assert.match(formatSummary(record([runs('jest', 'warm', 10), runs('jest', 'cold', 4)])), warning)
  assert.match(formatSummary(record([runs('jest', 'warm', 1)])), warning)
  // A desktop record this short can't be built, but a summary of one read back from disk can be.
  const shortDesktop: BenchRecord = {
    ...record([runs('jest', 'warm', 2), runs('jest', 'cold', 1)]),
    label: 'desktop',
  }
  assert.match(formatSummary(shortDesktop), /\[desktop\] WARNING: fewer runs than the R5 protocol/)
  const full = formatSummary(record([runs('jest', 'warm', 10), runs('jest', 'cold', 5)]))
  assert.doesNotMatch(full, /fewer runs/)
})

test('the summary names the commit and says when the tree was dirty', () => {
  const dirty = buildRecord({
    label: 'local',
    ref: { sha: 'abcdef0'.padEnd(40, '1'), date: '2026-11-02T10:00:00.000Z', dirty: true },
    environment,
    machineId: 'local-darwin-arm64',
    results: [result('jest', 'warm', [1])],
  })
  const text = formatSummary(dirty)
  assert.match(
    text,
    /\[local\] commit abcdef0 \(dirty: uncommitted changes when the bench started\)/,
  )
  assert.match(text, /\[local\] WARNING: .*dirty/)
  assert.ok(text.split('\n').every((line) => line.startsWith('[local] ')))
  assert.match(
    formatSummary(record([result('jest', 'warm', [1])])),
    /\[local\] commit aaaaaaa \(clean\)/,
  )
})

const sha = 'a'.repeat(40)
const date = '2026-11-02T10:00:00.000Z'

function recordOf(
  label: BenchRecord['label'],
  results: BenchResult[],
  dirty = false,
): () => BenchRecord {
  return () =>
    buildRecord({
      label,
      ref: { sha, date, dirty },
      environment,
      machineId: `${label}-darwin-arm64`,
      results,
    })
}

test('each label’s rules are one row of the policy table', () => {
  assert.deepEqual(Object.keys(LABEL_POLICY), [...BENCH_LABELS])
  assert.deepEqual(
    BENCH_LABELS.map((label) => [
      label,
      LABEL_POLICY[label].minWarm,
      LABEL_POLICY[label].minCold,
      LABEL_POLICY[label].requireClean,
    ]),
    [
      ['local', 1, 1, false],
      ['desktop', 10, 5, true],
      ['pinned', 10, 5, true],
    ],
  )
})

test('a record that can be quoted must hold the R5 run counts; a local one may be short', () => {
  for (const label of ['desktop', 'pinned'] as const) {
    assert.throws(recordOf(label, [runs('jest', 'warm', 1)]), code('BENCH_TOO_FEW_RUNS'), label)
    assert.throws(recordOf(label, [runs('jest', 'warm', 9)]), code('BENCH_TOO_FEW_RUNS'), label)
    assert.throws(recordOf(label, [runs('jest', 'cold', 4)]), code('BENCH_TOO_FEW_RUNS'), label)
    // one short result among full ones is enough
    assert.throws(
      recordOf(label, [runs('jest', 'warm', 10), runs('vitest', 'warm', 3)]),
      code('BENCH_TOO_FEW_RUNS'),
      label,
    )
    assert.equal(
      recordOf(label, [runs('jest', 'warm', 10), runs('jest', 'cold', 5)])().label,
      label,
    )
  }
  assert.equal(
    recordOf('local', [runs('jest', 'warm', 1), runs('jest', 'cold', 1)])().label,
    'local',
  )
  assert.throws(recordOf('pinned', [runs('jest', 'warm', 1)]), (error) =>
    (error as Error).message.includes('at least 10 warm and 5 cold'),
  )
})

test('a record that can be quoted must come from a clean tree; a local one may be dirty', () => {
  const full = [runs('jest', 'warm', 10), runs('jest', 'cold', 5)]
  for (const label of ['desktop', 'pinned'] as const) {
    assert.throws(
      recordOf(label, full, true),
      (error) => code('BENCH_DIRTY_TREE')(error) && (error as Error).message.includes(label),
      label,
    )
    assert.equal(recordOf(label, full, false)().ref.dirty, false)
  }
  assert.equal(recordOf('local', full, true)().ref.dirty, true)
})

test('a dirty tree is refused for desktop and pinned records only', () => {
  const dirty = { sha, date, dirty: true }
  const clean = { ...dirty, dirty: false }
  for (const label of ['desktop', 'pinned'] as const) {
    assert.throws(
      () => requireCleanTree(label, dirty),
      (error) => code('BENCH_DIRTY_TREE')(error) && (error as Error).message.includes(label),
      label,
    )
    requireCleanTree(label, clean)
  }
  requireCleanTree('local', dirty)
  requireCleanTree('local', clean)
})

test('the run counts a label accepts are read from its policy', () => {
  assert.equal(runsProblem('local', 'warm', 1), undefined)
  assert.equal(runsProblem('desktop', 'warm', 10), undefined)
  assert.equal(runsProblem('desktop', 'cold', 5), undefined)
  assert.match(runsProblem('desktop', 'warm', 9) ?? '', /^a desktop record needs at least 10 warm/)
  assert.match(runsProblem('pinned', 'cold', 4) ?? '', /^a pinned record needs at least.* 5 cold/)
})
