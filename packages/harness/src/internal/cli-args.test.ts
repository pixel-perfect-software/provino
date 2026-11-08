import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { parseCommandLine } from './cli-args.ts'

test('policy-diff takes exactly two dialect names', () => {
  assert.deepEqual(parseCommandLine(['policy-diff', 'jest', 'vitest']), {
    command: 'policy-diff',
    a: 'jest',
    b: 'vitest',
  })
  assert.deepEqual(parseCommandLine(['policy-diff', 'vitest', 'jest']), {
    command: 'policy-diff',
    a: 'vitest',
    b: 'jest',
  })
  for (const argv of [[], ['jest'], ['jest', 'mocha'], ['jest', 'vitest', 'jest']]) {
    assert.throws(() => parseCommandLine(['policy-diff', ...argv]), usageError)
  }
})

function usageError(error: unknown): boolean {
  return error instanceof HarnessError && error.code === 'HARNESS_USAGE'
}

test('record with no arguments means every fixture', () => {
  assert.deepEqual(parseCommandLine(['record']), {
    command: 'record',
    check: false,
    keepWorkDir: false,
    fixtures: [],
  })
})

test('record takes --check, --keep and fixture directories in any order', () => {
  assert.deepEqual(
    parseCommandLine(['record', '--check', 'fixtures/a/b', '--keep', 'fixtures/c/d']),
    {
      command: 'record',
      check: true,
      keepWorkDir: true,
      fixtures: ['fixtures/a/b', 'fixtures/c/d'],
    },
  )
})

test('a missing or unknown command, or an unknown flag, is a usage error', () => {
  assert.throws(() => parseCommandLine([]), usageError)
  assert.throws(() => parseCommandLine(['compare']), usageError)
  assert.throws(() => parseCommandLine(['--check', 'record']), usageError)
  assert.throws(() => parseCommandLine(['record', '--force']), usageError)
})

test('diff: --ref and --cand are required; the bars have R2 defaults', () => {
  assert.deepEqual(parseCommandLine(['diff', '--ref', 'r.json', '--cand', 'c.json']), {
    command: 'diff',
    ref: 'r.json',
    cand: 'c.json',
    mode: 'exact',
    console: false,
    min: 1,
    maxExcluded: 0.02,
    calibration: false,
  })
  assert.throws(() => parseCommandLine(['diff', '--ref', 'r.json']), usageError)
  assert.throws(() => parseCommandLine(['diff', '--cand', 'c.json']), usageError)
  assert.throws(() => parseCommandLine(['diff', 'r.json', 'c.json']), usageError)
})

test('diff takes every option', () => {
  assert.deepEqual(
    parseCommandLine([
      'diff',
      '--ref=r.json',
      '--cand=c.json',
      '--mode',
      'matcher',
      '--exclusions',
      'e.json',
      '--flaky',
      'f.json',
      '--console',
      '--min',
      '0.9',
      '--max-diffs',
      '0',
      '--max-excluded',
      '0.05',
      '--calibration',
      '--today',
      '2026-11-07',
    ]),
    {
      command: 'diff',
      ref: 'r.json',
      cand: 'c.json',
      mode: 'matcher',
      exclusions: 'e.json',
      flaky: 'f.json',
      console: true,
      min: 0.9,
      maxDiffs: 0,
      maxExcluded: 0.05,
      calibration: true,
      today: '2026-11-07',
    },
  )
})

test('diff refuses a bad mode, share, count or date', () => {
  const base = ['diff', '--ref', 'r.json', '--cand', 'c.json']
  for (const extra of [
    ['--mode', 'fuzzy'],
    ['--min', '1.5'],
    ['--min', '-0.1'],
    ['--min', ''],
    ['--min', 'all'],
    ['--min', '0x1'],
    ['--min', '1e0'],
    ['--min', '0b1'],
    ['--min', '1e-400'],
    ['--min', ' 0.5'],
    ['--max-excluded', '2e-2'],
    ['--max-excluded', '2'],
    ['--max-diffs', '-1'],
    ['--max-diffs', '1.5'],
    ['--today', '7 Nov 2026'],
  ]) {
    assert.throws(() => parseCommandLine([...base, ...extra]), usageError, extra.join(' '))
  }
})

test('convert: runner, input, root, suite and out are required; sidecar is for Jest and Vitest', () => {
  const args = ['--input', 'raw.json', '--root', '/work', '--suite', 's', '--out', 'out.json']
  assert.deepEqual(
    parseCommandLine(['convert', '--runner', 'jest', ...args, '--sidecar', 'c.jsonl']),
    {
      command: 'convert',
      runner: 'jest',
      input: 'raw.json',
      sidecar: 'c.jsonl',
      root: '/work',
      suite: 's',
      out: 'out.json',
    },
  )
  assert.deepEqual(
    parseCommandLine(['convert', '--runner', 'provino', ...args, '--runner-version', '0.0.0']),
    {
      command: 'convert',
      runner: 'provino',
      input: 'raw.json',
      root: '/work',
      suite: 's',
      out: 'out.json',
      runnerVersion: '0.0.0',
    },
  )
  assert.throws(() => parseCommandLine(['convert', ...args]), usageError)
  assert.throws(() => parseCommandLine(['convert', '--runner', 'mocha', ...args]), usageError)
  assert.throws(
    () => parseCommandLine(['convert', '--runner', 'provino', ...args, '--sidecar', 'c.jsonl']),
    usageError,
  )
  assert.throws(() => parseCommandLine(['convert', '--runner', 'jest', '--input', 'x']), usageError)
})

test('self-test: --out needs --candidate provino, and provino is the only candidate', () => {
  assert.deepEqual(parseCommandLine(['self-test']), {
    command: 'self-test',
    writeRecorded: false,
    keepWorkDir: false,
  })
  assert.deepEqual(
    parseCommandLine([
      'self-test',
      '--candidate',
      'provino',
      '--out',
      'report.json',
      '--write-recorded',
      '--keep',
      '--today',
      '2026-11-07',
    ]),
    {
      command: 'self-test',
      candidate: 'provino',
      out: 'report.json',
      writeRecorded: true,
      keepWorkDir: true,
      today: '2026-11-07',
    },
  )
  assert.throws(() => parseCommandLine(['self-test', '--out', 'report.json']), usageError)
  assert.throws(() => parseCommandLine(['self-test', '--candidate', 'jest']), usageError)
  assert.throws(() => parseCommandLine(['self-test', 'extra']), usageError)
})
