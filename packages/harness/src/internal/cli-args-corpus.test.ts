// `provino-harness corpus …`'s command line.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { type CorpusCommand, parseCommandLine } from './cli-args.ts'

function corpus(...args: string[]): CorpusCommand {
  const command = parseCommandLine(['corpus', ...args])
  assert.equal(command.command, 'corpus')
  if (command.command !== 'corpus') throw new Error('unreachable')
  return command
}

function usage(...args: string[]): void {
  assert.throws(
    () => parseCommandLine(['corpus', ...args]),
    (error) => error instanceof HarnessError && error.code === 'HARNESS_USAGE',
    args.join(' '),
  )
}

test('fetch --all --verify-only', () => {
  const command = corpus('fetch', '--all', '--verify-only')
  assert.equal(command.action, 'fetch')
  assert.deepEqual(command.selection, { kind: 'all' })
  assert.equal(command.verifyOnly, true)
})

test('run --pilot --runs 3 is the reference runs, and 3 is the default', () => {
  assert.equal(corpus('run', '--pilot', '--runs', '3').runs, 3)
  assert.equal(corpus('run', '--pilot').runs, 3)
  assert.deepEqual(corpus('run', '--pilot').selection, { kind: 'pilot' })
})

test('repository ids select by name; probe takes none', () => {
  assert.deepEqual(corpus('self-diff', 'swr', 'mobx').selection, {
    kind: 'ids',
    ids: ['swr', 'mobx'],
  })
  assert.equal(corpus('probe').action, 'probe')
})

test('install --offline and gate --out', () => {
  assert.equal(corpus('install', '--pilot', '--offline').offline, true)
  assert.equal(corpus('gate', '--pilot', '--out', 'g0.json').out, 'g0.json')
  assert.equal(corpus('gate', '--pilot', '--today', '2026-11-08').today, '2026-11-08')
})

test('a command line that names nothing, or too much, or a flag for another action, is a usage error', () => {
  usage()
  usage('frobnicate', '--all')
  usage('fetch')
  usage('fetch', '--all', '--pilot')
  usage('fetch', '--pilot', 'swr')
  usage('probe', '--all')
  usage('fetch', '--all', '--offline')
  usage('install', '--all', '--verify-only')
  usage('run', '--pilot', '--runs', '1')
  usage('run', '--pilot', '--runs', 'many')
  usage('flaky', '--pilot', '--out', 'x')
})

test('diff --suite supplies the exclusions and flaky list, so it refuses their flags and --calibration', () => {
  const diff = parseCommandLine(['diff', '--ref', 'a', '--cand', 'b', '--suite', 'swr'])
  assert.equal(diff.command === 'diff' && diff.suite, 'swr')
  for (const extra of [['--exclusions', 'e.json'], ['--flaky', 'f.json'], ['--calibration']]) {
    assert.throws(
      () => parseCommandLine(['diff', '--ref', 'a', '--cand', 'b', '--suite', 'swr', ...extra]),
      (error) => error instanceof HarnessError && error.code === 'HARNESS_USAGE',
      extra.join(' '),
    )
  }
})
