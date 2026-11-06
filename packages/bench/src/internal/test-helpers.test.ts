import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRecord } from '@provino/types'
import { wallStats } from '../stats.ts'
import { assertBenchRecord, testRecord } from './test-helpers.ts'

function valid(): BenchRecord {
  return testRecord([
    {
      benchId: 'app-1',
      subject: { runner: 'jest', version: '30.5.2', isolation: 'runner-default', command: 'run' },
      cache: 'warm',
      wall: wallStats([1, 2, 3]),
      ok: true,
    },
  ])
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
  // `assert.throws(fn, 'text')` treats the string as the failure message, so each case passes if
  // anything throws; a pattern for the field name makes it the right assertion that threw.
  const breaks: readonly [RegExp, readonly (string | number)[], unknown][] = [
    [/schemaVersion must be 1/, ['schemaVersion'], 2],
    [/label is invalid/, ['label'], 'production'],
    [/ref\.dirty must be a boolean/, ['ref', 'dirty'], REMOVE],
    [/ref\.date must be a date/, ['ref', 'date'], 'yesterday'],
    [/machine\.id must be a string/, ['machine', 'id'], REMOVE],
    [/machine\.cpuCount must be a finite number/, ['machine', 'cpuCount'], null],
    [/runners\.jest must be a string/, ['machine', 'runners', 'jest'], 30],
    [/results must be an array/, ['results'], {}],
    [/\.cache is invalid/, ['results', 0, 'cache'], 'hot'],
    [/\.ok must be a boolean/, ['results', 0, 'ok'], 'yes'],
    [/\.peakRssMb must be a finite number/, ['results', 0, 'peakRssMb'], null],
    [/subject\.isolation must be a string/, ['results', 0, 'subject', 'isolation'], REMOVE],
    [/wall\.medianMs must be a finite number/, ['results', 0, 'wall', 'medianMs'], null],
    [/samplesMs must be finite numbers/, ['results', 0, 'wall', 'samplesMs'], [1, null, 3]],
    [/wall\.runs must equal the sample count/, ['results', 0, 'wall', 'runs'], 9],
    [/unexpected field verdict/, ['verdict'], 'GO'],
    [/isolation must be one of/, ['results', 0, 'subject', 'isolation'], 'registy'],
    [/isolation must be one of/, ['results', 0, 'subject', 'isolation'], 'jest'],
    [/wall\.runs must be an integer/, ['results', 0, 'wall', 'runs'], 2.5],
  ]
  for (const [pattern, path, value] of breaks) {
    assert.throws(() => assertBenchRecord(broken(path, value)), pattern, String(pattern))
  }
  assert.throws(() => assertBenchRecord(null))
})
