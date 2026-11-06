import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { BenchRecord, IsolationMode } from '@provino/types'
import { BenchError, type BenchErrorCode } from '../errors.ts'
import { PACKAGE_DIR } from '../suites.ts'

/**
 * Makes a temp directory named `<prefix>…` under the OS temp dir and removes it when the test
 * ends.
 * @internal
 */
export async function scratch(t: Pick<TestContext, 'after'>, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Makes a directory for generated suites that a runner can run: under the bench package's
 * gitignored `.suites/`, because the suites import `date-fns`, `lodash` and `zod`, which resolve
 * from the package's `node_modules` and not from the OS temp dir. It is removed when the test ends.
 * @internal
 */
export async function scratchSuites(t: Pick<TestContext, 'after'>): Promise<string> {
  const parent = join(PACKAGE_DIR, '.suites')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A predicate for `assert.rejects` and `assert.throws`: the error is a `BenchError` with this code.
 * @internal
 */
export function code(expected: BenchErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof BenchError && error.code === expected
}

// `IsolationMode` (packages/types/src/bench.ts): the four tiers and the runner's own default.
const ISOLATION_MODES: readonly string[] = [
  'none',
  'registry',
  'realm',
  'process',
  'runner-default',
] satisfies readonly IsolationMode[]

type Fields = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, where: string): Fields {
  assert.ok(isObject(value), `${where} must be an object`)
  return value
}

function str(from: Fields, key: string, where: string): void {
  assert.equal(typeof from[key], 'string', `${where}.${key} must be a string`)
}

// A NaN or an Infinity becomes `null` in JSON, so a number that came from a file must be finite.
function num(from: Fields, key: string, where: string, optional = false): void {
  if (optional && !(key in from)) return
  const value = from[key]
  assert.ok(
    typeof value === 'number' && Number.isFinite(value),
    `${where}.${key} must be a finite number; got ${JSON.stringify(value)}`,
  )
}

function bool(from: Fields, key: string, where: string): void {
  assert.equal(typeof from[key], 'boolean', `${where}.${key} must be a boolean`)
}

function optionalStr(from: Fields, key: string, where: string): void {
  if (key in from) str(from, key, where)
}

function noExtra(from: Fields, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(from)) {
    assert.ok(allowed.includes(key), `${where} has an unexpected field ${key}`)
  }
}

/**
 * Strictly checks that a value is a `BenchRecord`, field by field: `BenchRecord`, `RunRef`, the
 * machine (`RunEnvironment` plus `id`), each `BenchResult`, `BenchSubject` and `WallStats`.
 * Numbers must be finite, the label and cache state valid, and `schemaVersion` 1. No unknown field
 * is allowed, so a verdict or parity field added to a record fails.
 * @internal
 */
export function assertBenchRecord(value: unknown): asserts value is BenchRecord {
  const record = object(value, 'record')
  noExtra(record, ['schemaVersion', 'label', 'ref', 'machine', 'results'], 'record')
  assert.equal(record.schemaVersion, 1, 'record.schemaVersion must be 1')
  assert.ok(
    ['local', 'desktop', 'pinned'].includes(String(record.label)),
    'record.label is invalid',
  )

  const ref = object(record.ref, 'record.ref')
  noExtra(ref, ['sha', 'date', 'dirty', 'release'], 'record.ref')
  str(ref, 'sha', 'record.ref')
  str(ref, 'date', 'record.ref')
  assert.ok(!Number.isNaN(Date.parse(String(ref.date))), 'record.ref.date must be a date')
  bool(ref, 'dirty', 'record.ref')
  optionalStr(ref, 'release', 'record.ref')

  const machine = object(record.machine, 'record.machine')
  noExtra(
    machine,
    [
      'os',
      'osRelease',
      'arch',
      'cpuModel',
      'cpuCount',
      'memoryMb',
      'node',
      'runners',
      'ci',
      'id',
      'governor',
    ],
    'record.machine',
  )
  for (const key of ['os', 'osRelease', 'arch', 'cpuModel', 'node', 'id']) {
    str(machine, key, 'record.machine')
  }
  num(machine, 'cpuCount', 'record.machine')
  num(machine, 'memoryMb', 'record.machine')
  bool(machine, 'ci', 'record.machine')
  optionalStr(machine, 'governor', 'record.machine')
  const runners = object(machine.runners, 'record.machine.runners')
  for (const key of Object.keys(runners)) str(runners, key, 'record.machine.runners')

  assert.ok(Array.isArray(record.results), 'record.results must be an array')
  record.results.forEach((entry: unknown, index) => {
    const where = `record.results[${index}]`
    const result = object(entry, where)
    noExtra(
      result,
      [
        'benchId',
        'subject',
        'cache',
        'wall',
        'peakRssMb',
        'cpuUserMs',
        'cpuSysMs',
        'instructions',
        'ok',
      ],
      where,
    )
    str(result, 'benchId', where)
    assert.ok(['cold', 'warm'].includes(String(result.cache)), `${where}.cache is invalid`)
    bool(result, 'ok', where)
    for (const key of ['peakRssMb', 'cpuUserMs', 'cpuSysMs', 'instructions']) {
      num(result, key, where, true)
    }

    const subject = object(result.subject, `${where}.subject`)
    noExtra(
      subject,
      ['runner', 'version', 'isolation', 'command', 'configPath'],
      `${where}.subject`,
    )
    for (const key of ['runner', 'version', 'isolation', 'command']) {
      str(subject, key, `${where}.subject`)
    }
    assert.ok(
      ISOLATION_MODES.includes(String(subject.isolation)),
      `${where}.subject.isolation must be one of ${ISOLATION_MODES.join(', ')}; got ${JSON.stringify(subject.isolation)}`,
    )
    optionalStr(subject, 'configPath', `${where}.subject`)

    const wall = object(result.wall, `${where}.wall`)
    noExtra(
      wall,
      [
        'runs',
        'medianMs',
        'q1Ms',
        'q3Ms',
        'minMs',
        'maxMs',
        'ciLowMs',
        'ciHighMs',
        'cv',
        'samplesMs',
      ],
      `${where}.wall`,
    )
    for (const key of [
      'runs',
      'medianMs',
      'q1Ms',
      'q3Ms',
      'minMs',
      'maxMs',
      'ciLowMs',
      'ciHighMs',
      'cv',
    ]) {
      num(wall, key, `${where}.wall`)
    }
    assert.ok(Number.isInteger(wall.runs), `${where}.wall.runs must be an integer`)
    const samples = wall.samplesMs
    assert.ok(
      Array.isArray(samples) &&
        samples.every((sample) => typeof sample === 'number' && Number.isFinite(sample)),
      `${where}.wall.samplesMs must be finite numbers`,
    )
    assert.equal(samples.length, wall.runs, `${where}.wall.runs must equal the sample count`)
  })
}
