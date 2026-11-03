import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLimit, readSample, SAMPLE_PREFIX } from './limits.ts'

test('a bar flag must be a finite number, or the check could never fail', () => {
  assert.equal(parseLimit('max-tobe-us', undefined), undefined)
  assert.equal(parseLimit('max-tobe-us', '1'), 1)
  assert.equal(parseLimit('max-tobe-us', '0.5'), 0.5)
  for (const bad of ['1us', 'abc', '', '1,0', 'Infinity']) {
    assert.throws(() => parseLimit('max-tobe-us', bad), {
      name: 'BenchError',
      code: 'BENCH_USAGE',
      message: `--max-tobe-us needs a number, got "${bad}"`,
    })
  }
})

test('a sample is the prefixed output line with every named key a finite number', () => {
  const keys = ['toBe', 'toEqual'] as const
  const sample = `${SAMPLE_PREFIX}{"toBe":1,"toEqual":2}`
  assert.deepEqual(readSample(`warning\n${sample}\n`, keys), { toBe: 1, toEqual: 2 })
  // A JSON-looking log line without the prefix is ignored, before or after the sample.
  assert.deepEqual(readSample(`{"toBe":9,"toEqual":9}\n${sample}`, keys), { toBe: 1, toEqual: 2 })
  assert.equal(readSample('{"toBe":1,"toEqual":2}', keys), undefined)
  assert.equal(readSample(`${SAMPLE_PREFIX}{"toBe":1}`, keys), undefined)
  assert.equal(readSample(`${SAMPLE_PREFIX}{"toBe":1,"toEqual":null}`, keys), undefined)
  assert.equal(readSample(`${SAMPLE_PREFIX}{"toBe":1,`, keys), undefined)
  assert.equal(readSample('', keys), undefined)
})
