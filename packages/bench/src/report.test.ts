import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRecord, BenchResult, BenchSubject, RunEnvironment } from '@provino/types'
import { BenchError } from './errors.ts'
import {
  buildRecord,
  defaultMachineId,
  defaultOutPath,
  formatSummary,
  parseLabel,
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
    assert.throws(
      () => parseLabel(bad),
      (error) => error instanceof BenchError && error.code === 'BENCH_USAGE',
    )
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
  const built = record([result('jest', 'warm', [100, 110])], 'desktop')
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
  assert.match(
    formatSummary(record([result('jest', 'warm', [1])], 'desktop')),
    /\[desktop\] .*provisional/,
  )
  assert.match(
    formatSummary(record([result('jest', 'warm', [1])], 'pinned')),
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
  assert.match(
    formatSummary(record([runs('jest', 'warm', 2), runs('jest', 'cold', 1)], 'desktop')),
    /\[desktop\] WARNING: fewer runs than the R5 protocol/,
  )
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
