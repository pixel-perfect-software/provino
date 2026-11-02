import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { parseCommandLine } from './cli-args.ts'

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
  assert.throws(() => parseCommandLine(['diff']), usageError)
  assert.throws(() => parseCommandLine(['record', '--force']), usageError)
})
