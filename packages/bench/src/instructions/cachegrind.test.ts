import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BenchError } from '../errors.ts'
import {
  instructionsOf,
  parseCachegrind,
  readCachegrindDir,
  totalInstructions,
} from './cachegrind.ts'

const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url))
const fixture = (name: string): string => readFileSync(`${fixtures}${name}`, 'utf8')
const isOutputError = (error: unknown): boolean =>
  error instanceof BenchError && error.code === 'BENCH_CACHEGRIND_OUTPUT'

test('a --cache-sim=no file: the command, one Ir column, its summary', () => {
  const profile = parseCachegrind(fixture('cachegrind.out.4101'))
  assert.match(profile.cmd ?? '', /--single-threaded --no-opt --predictable/)
  assert.deepEqual(profile.events, ['Ir'])
  assert.deepEqual(profile.totals, [2_400_060_000])
  assert.equal(instructionsOf(profile), 2_400_060_000)
})

test('a --cache-sim=yes file: Ir is read from its column among nine', () => {
  const profile = parseCachegrind(fixture('cache-sim.out'))
  assert.equal(profile.events.length, 9)
  assert.equal(instructionsOf(profile), 123_456_789)
})

test('--trace-children writes a file per process; the run is their sum', async () => {
  const files = await readCachegrindDir(fixtures)
  assert.deepEqual(
    files.map((file) => file.name),
    ['cachegrind.out.4101', 'cachegrind.out.4102'],
  )
  assert.equal(totalInstructions(files), 2_400_060_000 + 939_999)
})

test('totals: is read when there is no summary:, and summary: wins when both are there', () => {
  assert.deepEqual(parseCachegrind('events: Ir\ntotals: 42\n').totals, [42])
  assert.deepEqual(parseCachegrind('events: Ir\nsummary: 7\ntotals: 42\n').totals, [7])
})

test('a file the run never finished (no summary) is an error, not zero', () => {
  assert.throws(
    () => parseCachegrind(fixture('unfinished.out'), 'unfinished.out'),
    (error) => {
      assert.ok(isOutputError(error))
      assert.match((error as Error).message, /unfinished\.out: no summary/)
      return true
    },
  )
})

test('malformed files are errors', () => {
  for (const text of [
    'summary: 1\n',
    'events: Ir\nsummary: 12x\n',
    'events: Ir Dr\nsummary: 12\n',
    'events: Dr\nsummary: 12\n',
    'events: Ir\nsummary: -3\n',
  ]) {
    assert.throws(() => instructionsOf(parseCachegrind(text)), isOutputError, text)
  }
  assert.throws(() => totalInstructions([]), isOutputError)
})
