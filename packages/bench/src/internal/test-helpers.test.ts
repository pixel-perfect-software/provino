import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRecord } from '@provino/types'
import { wallStats } from '../stats.ts'
import { assertBenchRecord } from './test-helpers.ts'

function valid(): BenchRecord {
  return {
    schemaVersion: 1,
    label: 'local',
    ref: { sha: 'a'.repeat(40), date: '2026-11-02T10:00:00.000Z', dirty: false },
    machine: {
      os: 'darwin',
      osRelease: '27.2.0',
      arch: 'arm64',
      cpuModel: 'Test CPU',
      cpuCount: 8,
      memoryMb: 16384,
      node: 'v24.0.0',
      runners: { jest: '30.5.2' },
      ci: false,
      id: 'local-darwin-arm64',
    },
    results: [
      {
        benchId: 'app-1',
        subject: { runner: 'jest', version: '30.5.2', isolation: 'runner-default', command: 'run' },
        cache: 'warm',
        wall: wallStats([1, 2, 3]),
        ok: true,
      },
    ],
  }
}

const REMOVE = Symbol('remove')

// A deep copy (through JSON, like a file) with the value at `path` replaced or removed.
function broken(path: readonly (string | number)[], value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(valid()))
  let at = copy as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>
  const last = path.at(-1) as string | number
  if (value === REMOVE) delete at[last]
  else at[last] = value
  return copy
}

test('a well-formed record passes, through JSON too', () => {
  assertBenchRecord(valid())
  assertBenchRecord(JSON.parse(JSON.stringify(valid())))
})

test('a broken record fails, whichever field is wrong', () => {
  const breaks: readonly [string, readonly (string | number)[], unknown][] = [
    ['schemaVersion', ['schemaVersion'], 2],
    ['label', ['label'], 'production'],
    ['ref.dirty', ['ref', 'dirty'], REMOVE],
    ['ref.date', ['ref', 'date'], 'yesterday'],
    ['machine.id', ['machine', 'id'], REMOVE],
    ['machine.cpuCount', ['machine', 'cpuCount'], null],
    ['machine.runners', ['machine', 'runners', 'jest'], 30],
    ['results', ['results'], {}],
    ['result.cache', ['results', 0, 'cache'], 'hot'],
    ['result.ok', ['results', 0, 'ok'], 'yes'],
    ['result.peakRssMb', ['results', 0, 'peakRssMb'], null],
    ['subject.isolation', ['results', 0, 'subject', 'isolation'], REMOVE],
    ['wall.medianMs NaN', ['results', 0, 'wall', 'medianMs'], null],
    ['wall.samplesMs', ['results', 0, 'wall', 'samplesMs'], [1, null, 3]],
    ['wall.runs', ['results', 0, 'wall', 'runs'], 9],
    ['an extra field', ['verdict'], 'GO'],
  ]
  for (const [name, path, value] of breaks) {
    assert.throws(() => assertBenchRecord(broken(path, value)), name)
  }
  assert.throws(() => assertBenchRecord(null))
})
