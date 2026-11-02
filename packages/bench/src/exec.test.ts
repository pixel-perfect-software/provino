import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BenchError } from './errors.ts'
import { execProcess, parseTimes } from './exec.ts'
import { readProcessTable } from './tree-rss.ts'

test('times output parses to the children’s user and system time', () => {
  // bash: milliseconds. First line is the shell itself, second is what it waited for.
  assert.deepEqual(parseTimes('0m0.012s 0m0.020s\n1m2.500s 0m0.250s\n'), {
    userMs: 62500,
    sysMs: 250,
  })
  // dash and busybox print centiseconds
  assert.deepEqual(parseTimes('0m0.00s 0m0.01s\n0m3.41s 0m0.57s\n'), { userMs: 3410, sysMs: 570 })
})

test('unreadable times output gives no CPU figures', () => {
  assert.equal(parseTimes(''), undefined)
  assert.equal(parseTimes('0m0.012s 0m0.020s\n'), undefined)
  assert.equal(parseTimes('0m0.012s 0m0.020s\nsomething else\n'), undefined)
})

// This goes through the real default exec with a real process. The command spins the CPU for about
// 150 ms (a busy loop in the child, not a wait here), which gives the sampler and `times` something
// to see.
const spin = ['-e', 'const t = performance.now(); while (performance.now() - t < 150);']

test('the default exec measures wall, CPU and exit code of a real process', async () => {
  const outcome = await execProcess({
    argv: [process.execPath, ...spin],
    cwd: process.cwd(),
    env: {},
  })
  assert.equal(outcome.exitCode, 0)
  assert.ok(outcome.wallMs >= 150, `wall ${outcome.wallMs} ms`)
  assert.ok(
    outcome.cpuUserMs !== undefined && outcome.cpuUserMs > 0,
    `user ${outcome.cpuUserMs} ms`,
  )
  assert.ok(outcome.cpuSysMs !== undefined && outcome.cpuSysMs >= 0, `sys ${outcome.cpuSysMs} ms`)
})

test('the default exec reports tree RSS where the process table is readable, and says why not where it is not', async () => {
  const outcome = await execProcess({
    argv: [process.execPath, ...spin],
    cwd: process.cwd(),
    env: {},
  })
  let readable = true
  try {
    await readProcessTable()
  } catch (error) {
    readable = !(error instanceof BenchError && error.code === 'BENCH_PROCESS_TABLE_UNAVAILABLE')
  }
  if (readable) {
    assert.ok(
      outcome.peakRssMb !== undefined && outcome.peakRssMb > 5,
      `rss ${outcome.peakRssMb} MiB`,
    )
  } else {
    assert.equal(outcome.peakRssMb, undefined)
    assert.ok(outcome.warnings?.some((warning) => warning.includes('peak tree RSS unavailable')))
  }
})

test('the default exec passes the exit code through and applies cwd and env', async () => {
  const failed = await execProcess({
    argv: [process.execPath, '-e', 'process.exit(7)'],
    cwd: process.cwd(),
    env: {},
  })
  assert.equal(failed.exitCode, 7)
  assert.ok(failed.cpuUserMs !== undefined)

  const env = await execProcess({
    argv: [process.execPath, '-e', 'process.exit(process.env.BENCH_PROBE === "yes" ? 0 : 1)'],
    cwd: process.cwd(),
    env: { BENCH_PROBE: 'yes' },
  })
  assert.equal(env.exitCode, 0)

  const cwd = await execProcess({
    argv: [
      process.execPath,
      '-e',
      'process.exit(process.cwd() === process.argv[1] ? 0 : 1)',
      '--',
      '/',
    ],
    cwd: '/',
    env: {},
  })
  assert.equal(cwd.exitCode, 0)
})

test('a command that is not found exits non-zero rather than throwing', async () => {
  const outcome = await execProcess({
    argv: ['/nonexistent/bench-probe'],
    cwd: process.cwd(),
    env: {},
  })
  assert.equal(outcome.exitCode, 127)
})

test('a missing cwd is a BENCH_EXEC_FAILED error', async () => {
  await assert.rejects(
    execProcess({ argv: ['true'], cwd: '/nonexistent/bench-dir', env: {} }),
    (error) => error instanceof BenchError && error.code === 'BENCH_EXEC_FAILED',
  )
})
