// The `e2e` leg's pure parts: the arguments each subject runs with, and the CPU probe's lines.
// No suite runs here (that is Tyler's terminal session).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BenchError } from '../errors.ts'
import { CPU_FILE_VARIABLE, cpuProbeImport, E2E_SUBJECTS, e2eArgs, parseCpuProbe } from './e2e.ts'

test('each subject is provino run on the suite’s config with one reporter named', () => {
  assert.deepEqual(E2E_SUBJECTS, ['provino', 'agent'])
  assert.deepEqual(e2eArgs('provino', 'provino.config.mjs'), [
    'run',
    '--config',
    'provino.config.mjs',
    '--reporter',
    'provino',
  ])
  assert.deepEqual(e2eArgs('agent', 'provino.config.mjs').at(-1), 'agent')
})

test('the probe keeps the line of the pid asked for, in ms of user plus system CPU', () => {
  const text = [
    JSON.stringify({ pid: 11, cpu: { user: 4000, system: 1000 } }),
    JSON.stringify({ pid: 10, cpu: { user: 250_000, system: 50_000 } }),
    '',
  ].join('\n')
  assert.equal(parseCpuProbe(text, 10), 300)
  assert.equal(parseCpuProbe(text, 11), 5)
  assert.equal(parseCpuProbe(text, 12), undefined)
  assert.throws(
    () => parseCpuProbe('{"pid":10}\n', 10),
    (error) => error instanceof BenchError && error.code === 'BENCH_LEG_FAILED',
  )
})

test('the preload writes its process’s line at exit, and one per child that inherits it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provino-cpu-probe-'))
  try {
    const file = join(dir, 'cpu.jsonl')
    const pid = execFileSync(
      process.execPath,
      [
        '-e',
        "require('node:child_process').execFileSync(process.execPath, ['-e', '0']); process.stdout.write(String(process.pid))",
      ],
      {
        env: { ...process.env, NODE_OPTIONS: cpuProbeImport(), [CPU_FILE_VARIABLE]: file },
        encoding: 'utf8',
      },
    )
    const text = await readFile(file, 'utf8')
    assert.equal(text.trim().split('\n').length, 2, text)
    const ms = parseCpuProbe(text, Number(pid))
    assert.ok(ms !== undefined && ms > 0, text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
