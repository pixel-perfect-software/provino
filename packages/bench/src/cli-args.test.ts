import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCli } from './cli-args.ts'
import { runCli } from './commands.ts'
import { BenchError } from './errors.ts'
import { code } from './internal/test-helpers.ts'

function usageError(argv: string[]): void {
  assert.throws(() => parseCli(argv), code('BENCH_USAGE'), argv.join(' '))
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

test('check takes the same --timeout as run, with the same default', () => {
  const timeout = (...rest: string[]) => parseCli(['check', 'app-5', '--runner', 'jest', ...rest])
  assert.equal((timeout() as { timeoutMs: number }).timeoutMs, 30 * 60_000)
  assert.equal((timeout('--timeout', '45') as { timeoutMs: number }).timeoutMs, 45 * 60_000)
  for (const bad of ['0', '1.5', 'soon', '', '35792']) {
    usageError(['check', 'app-5', '--runner', 'jest', '--timeout', bad])
  }
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
  assert.equal(parsed.timeoutMs, 30 * 60_000)
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
    '12',
    '--cold',
    '6',
    '--label',
    'desktop',
    '--out',
    'x.json',
    '--machine-id',
    'box-1',
    '--timeout',
    '45',
  ])
  assert.equal(parsed.command, 'run')
  if (parsed.command !== 'run') return
  assert.deepEqual(
    [
      parsed.runners.join(),
      parsed.warm,
      parsed.cold,
      parsed.label,
      parsed.out,
      parsed.machineId,
      parsed.timeoutMs,
    ],
    ['jest,vitest', 12, 6, 'desktop', 'x.json', 'box-1', 45 * 60_000],
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

test('run counts are plain positive integers, not whatever Number() accepts', () => {
  for (const bad of [
    '1e21',
    '1e1',
    ' 7',
    '7 ',
    '+7',
    '0x10',
    '1.0',
    '07',
    '-1',
    '0',
    '',
    '99999999999999999999',
  ]) {
    usageError(['run', 'app-5', '--runner', 'jest', '--warm', bad])
    usageError(['run', 'app-5', '--runner', 'jest', '--cold', bad])
  }
  const parsed = parseCli(['run', 'app-5', '--runner', 'jest', '--warm', '12', '--cold', '3'])
  assert.deepEqual(parsed.command === 'run' && [parsed.warm, parsed.cold], [12, 3])
})

function protocolError(argv: string[]): void {
  assert.throws(
    () => parseCli(argv),
    (error) =>
      code('BENCH_USAGE')(error) && /at least 10 warm and 5 cold/.test((error as Error).message),
    argv.join(' '),
  )
}

test('desktop and pinned records need the R5 protocol: at least 10 warm and 5 cold runs', () => {
  for (const label of ['desktop', 'pinned']) {
    const base = ['run', 'app-5', '--runner', 'jest', '--label', label]
    protocolError([...base, '--warm', '1', '--cold', '1'])
    protocolError([...base, '--warm', '9', '--cold', '5'])
    protocolError([...base, '--warm', '10', '--cold', '4'])
    protocolError([...base, '--warm', '2'])
    protocolError([...base, '--cold', '2'])
    const exact = parseCli([...base, '--warm', '10', '--cold', '5'])
    assert.equal(exact.command === 'run' && exact.label, label)
    assert.equal(parseCli(base).command, 'run')
  }
})

test('a local run below the protocol is allowed; the summary warns about it', () => {
  const parsed = parseCli(['run', 'app-5', '--runner', 'jest', '--warm', '1', '--cold', '1'])
  assert.deepEqual(parsed.command === 'run' && [parsed.label, parsed.warm, parsed.cold], [
    'local',
    1,
    1,
  ])
})

test('--timeout is whole minutes, at least one, and small enough for a timer', () => {
  const timeout = (value: string) =>
    parseCli(['run', 'app-5', '--runner', 'jest', '--timeout', value])
  assert.equal((timeout('1') as { timeoutMs: number }).timeoutMs, 60_000)
  assert.equal((timeout('35791') as { timeoutMs: number }).timeoutMs, 35791 * 60_000)
  for (const bad of ['0', '1.5', '1e1', 'soon', '', '35792']) {
    usageError(['run', 'app-5', '--runner', 'jest', '--timeout', bad])
  }
})

test('an empty --out or --machine-id is rejected', () => {
  for (const flag of ['--out', '--machine-id']) {
    for (const empty of ['', '   ']) {
      usageError(['run', 'app-5', '--runner', 'jest', flag, empty])
    }
  }
})

test('an option that does not apply to the command is rejected rather than ignored', () => {
  usageError(['generate', 'app-5', '--runner', 'jest'])
  usageError(['generate', 'app-5', '--label', 'pinned'])
  usageError(['generate', 'app-5', '--warm', '3'])
  usageError(['check', 'app-5', '--runner', 'jest', '--label', 'pinned'])
  usageError(['check', 'app-5', '--runner', 'jest', '--warm', '3'])
  usageError(['check', 'app-5', '--runner', 'jest', '--cold', '3'])
  usageError(['check', 'app-5', '--runner', 'jest', '--out', 'x.json'])
  usageError(['check', 'app-5', '--runner', 'jest', '--machine-id', 'x'])
  assert.equal(parseCli(['check', 'app-5', '--runner', 'jest']).command, 'check')
  assert.equal(parseCli(['generate', 'app-5']).command, 'generate')
  assert.throws(
    () => parseCli(['check', 'app-5', '--runner', 'jest', '--label', 'pinned']),
    (error) => error instanceof BenchError && /--label does not apply to check/.test(error.message),
  )
})

test('an unknown suite is reported as such', () => {
  assert.throws(() => parseCli(['generate', 'jsdom-5']), code('BENCH_UNKNOWN_SUITE'))
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
