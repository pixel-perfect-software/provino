import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCli } from './cli-args.ts'
import { runCli } from './commands.ts'
import { BenchError } from './errors.ts'

function usageError(argv: string[]): void {
  assert.throws(
    () => parseCli(argv),
    (error) => error instanceof BenchError && error.code === 'BENCH_USAGE',
    argv.join(' '),
  )
}

test('no command, help and --help print usage', () => {
  assert.deepEqual(parseCli([]), { command: 'help' })
  assert.deepEqual(parseCli(['help']), { command: 'help' })
  assert.deepEqual(parseCli(['--help']), { command: 'help' })
})

test('generate takes a suite', () => {
  const parsed = parseCli(['generate', 'app-500'])
  assert.equal(parsed.command, 'generate')
  assert.equal(parsed.command === 'generate' && parsed.suite.files, 500)
})

test('check takes one or more runners, once each', () => {
  const parsed = parseCli([
    'check',
    'isolate-heavy',
    '--runner',
    'jest',
    '--runner',
    'vitest',
    '--runner',
    'jest',
  ])
  assert.equal(parsed.command === 'check' && parsed.runners.join(), 'jest,vitest')
})

test('run defaults to 10 warm runs, 5 cold runs and the local label', () => {
  const parsed = parseCli(['run', 'app-50', '--runner', 'jest'])
  assert.equal(parsed.command, 'run')
  if (parsed.command !== 'run') return
  assert.equal(parsed.warm, 10)
  assert.equal(parsed.cold, 5)
  assert.equal(parsed.label, 'local')
  assert.equal(parsed.out, undefined)
  assert.equal(parsed.machineId, undefined)
})

test('run takes every option', () => {
  const parsed = parseCli([
    'run',
    'mock-heavy-500',
    '--runner',
    'jest',
    '--runner',
    'vitest',
    '--warm',
    '2',
    '--cold',
    '1',
    '--label',
    'desktop',
    '--out',
    'x.json',
    '--machine-id',
    'box-1',
  ])
  assert.equal(parsed.command, 'run')
  if (parsed.command !== 'run') return
  assert.deepEqual(
    [parsed.runners.join(), parsed.warm, parsed.cold, parsed.label, parsed.out, parsed.machineId],
    ['jest,vitest', 2, 1, 'desktop', 'x.json', 'box-1'],
  )
})

test('usage errors have a stable code', () => {
  usageError(['check', 'app-5'])
  usageError(['run', 'app-5'])
  usageError(['run', 'app-5', '--runner', 'mocha'])
  usageError(['run', 'app-5', '--runner', 'jest', '--label', 'prod'])
  usageError(['run', 'app-5', '--runner', 'jest', '--warm', '0'])
  usageError(['run', 'app-5', '--runner', 'jest', '--cold', 'many'])
  usageError(['run', 'app-5', '--runner', 'jest', '--nonsense'])
  usageError(['run'])
  usageError(['bench', 'app-5'])
  usageError(['generate', 'app-5', 'extra'])
})

test('an unknown suite is reported as such', () => {
  assert.throws(
    () => parseCli(['generate', 'jsdom-5']),
    (error) => error instanceof BenchError && error.code === 'BENCH_UNKNOWN_SUITE',
  )
})

test('runCli prints usage for help and exits 2 on a usage error, without running anything', async () => {
  const out: string[] = []
  const err: string[] = []
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) }
  assert.equal(await runCli(['--help'], io), 0)
  assert.match(out.join('\n'), /provino-bench generate <suite>/)
  assert.equal(await runCli(['run', 'app-5'], io), 2)
  assert.match(err.join('\n'), /BENCH_USAGE: pass at least one --runner/)
  assert.equal(await runCli(['generate', 'nope'], io), 1)
  assert.match(err.join('\n'), /BENCH_UNKNOWN_SUITE/)
})
