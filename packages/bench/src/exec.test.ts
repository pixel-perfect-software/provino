import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkMs,
  execProcess,
  exitCodeOf,
  isTimerMs,
  MAX_RUN_TIMEOUT_MS,
  parseTimes,
} from './exec.ts'
import { hasCode } from './internal/guards.ts'
import { code, scratch } from './internal/test-helpers.ts'
import { createDefaultReader } from './tree-rss.ts'

// The child processes below import this package's source, so they need the same export condition
// the tests run under, and the harness by URL.
const SOURCE = '--conditions=provino-source'
const HARNESS_URL = import.meta.resolve('@provino/harness')

test('times output parses to the children’s user and system time', () => {
  // bash: milliseconds. First line is the shell itself, second is what it waited for.
  assert.deepEqual(parseTimes('0m0.012s 0m0.020s\n1m2.500s 0m0.250s\n'), {
    userMs: 62500,
    sysMs: 250,
  })
  // dash and busybox print centiseconds
  assert.deepEqual(parseTimes('0m0.00s 0m0.01s\n0m3.41s 0m0.57s\n'), { userMs: 3410, sysMs: 570 })
})

test('dash up to 0.5.10.2 prints the total in the seconds field, so CPU above a minute is not inflated', () => {
  // Ubuntu 20.04 and Debian 10: minutes are total/60 but seconds are the whole total, so 100 s
  // arrives as 1m100.000000s and must not become 160 s.
  assert.deepEqual(parseTimes('0m0.000000s 0m0.000000s\n1m100.000000s 2m150.500000s\n'), {
    userMs: 100000,
    sysMs: 150500,
  })
  // a correct shell prints 100 s as 1m40.000000s
  assert.deepEqual(parseTimes('0m0.000000s 0m0.000000s\n1m40.000000s 2m30.500000s\n'), {
    userMs: 100000,
    sysMs: 150500,
  })
  // a total of exactly a minute arrives as 1m60.00s; a correct shell never prints 60 seconds
  assert.deepEqual(parseTimes('0m0.00s 0m0.00s\n1m60.00s 0m0.00s\n'), { userMs: 60000, sysMs: 0 })
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

// Long enough that the 25 ms sampler sees the child after Node has loaded: with `spin`'s 150 ms, a
// slow runner (CI's Node 22.15 leg, run 41720304210) can take every sample before that, at under
// 2 MiB.
const longSpin = ['-e', 'const t = performance.now(); while (performance.now() - t < 750);']

test('the default exec reports tree RSS where the process table is readable, and says why not where it is not', async () => {
  const outcome = await execProcess({
    argv: [process.execPath, ...longSpin],
    cwd: process.cwd(),
    env: {},
  })
  let readable = true
  try {
    await createDefaultReader(process.pid)()
  } catch (error) {
    readable = !code('BENCH_PROCESS_TABLE_UNAVAILABLE')(error)
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
    code('BENCH_EXEC_FAILED'),
  )
})

// Timeouts. The subjects are shell one-liners that record their own pid and then sleep far longer
// than the timeout, so a missing timeout shows up as a failed assertion, not a hang in the fix.
function sleeper(script: string, pidFile: string): string[] {
  return ['/bin/sh', '-c', script, pidFile]
}

// A killed process stays visible to `kill -0` until its parent (init, once the shell is gone)
// reaps it. On Linux a zombie counts as gone; elsewhere wait briefly for the reap.
async function isGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (hasCode(error, 'ESRCH')) return true
      throw error
    }
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return true
    } catch {
      // no /proc (macOS): fall through to the next attempt
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('a run past its timeout is killed, kept as a failed run with exit 124, and leaves no process behind', async (t) => {
  const dir = await scratch(t, 'bench-exec-')
  const pidFile = join(dir, 'pid')
  const outcome = await execProcess({
    argv: sleeper('echo $$ > "$0"; exec sleep 20', pidFile),
    cwd: process.cwd(),
    env: {},
    timeoutMs: 300,
  })
  assert.equal(outcome.exitCode, 124)
  assert.ok(
    outcome.warnings?.some((warning) => warning.includes('timed out')),
    String(outcome.warnings),
  )
  assert.ok(outcome.wallMs >= 300 && outcome.wallMs < 10_000, `wall ${outcome.wallMs} ms`)
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(Number.isInteger(pid) && pid > 0, `pid ${pid}`)
  assert.ok(await isGone(pid), `process ${pid} survived the timeout`)
})

test('a subject that ignores SIGTERM is killed with SIGKILL after the grace period', async (t) => {
  const dir = await scratch(t, 'bench-exec-')
  const pidFile = join(dir, 'pid')
  const outcome = await execProcess({
    argv: sleeper('trap "" TERM; echo $$ > "$0"; exec sleep 20', pidFile),
    cwd: process.cwd(),
    env: {},
    timeoutMs: 300,
    killGraceMs: 100,
  })
  assert.equal(outcome.exitCode, 124)
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(await isGone(pid), `process ${pid} ignored SIGTERM and survived`)
})

test('the whole process group is killed, not only the shell', async (t) => {
  const dir = await scratch(t, 'bench-exec-')
  const pidFile = join(dir, 'pid')
  // The sleeper is a grandchild: the wrapper shell runs this shell, which runs sleep in the
  // background and records the pid of that.
  const outcome = await execProcess({
    argv: sleeper('sleep 20 & echo $! > "$0"; wait', pidFile),
    cwd: process.cwd(),
    env: {},
    timeoutMs: 300,
  })
  assert.equal(outcome.exitCode, 124)
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(await isGone(pid), `grandchild ${pid} survived the timeout`)
})

test('a run that finishes in time is not affected by the timeout', async () => {
  const outcome = await execProcess({
    argv: [process.execPath, '-e', 'process.exit(3)'],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 60_000,
  })
  assert.equal(outcome.exitCode, 3)
  assert.ok(!outcome.warnings?.some((warning) => warning.includes('timed out')))
  assert.ok(outcome.cpuUserMs !== undefined, 'fd 3 and the times wrapper still work')
})

test('an invalid timeout is rejected before anything is spawned', async () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      execProcess({ argv: ['true'], cwd: process.cwd(), env: {}, timeoutMs }),
      code('BENCH_INVALID_SPEC'),
      String(timeoutMs),
    )
  }
  for (const killGraceMs of [-1, 1.5, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      execProcess({ argv: ['true'], cwd: process.cwd(), env: {}, killGraceMs }),
      code('BENCH_INVALID_SPEC'),
      `killGraceMs ${killGraceMs}`,
    )
  }
})

test('a timeout is a whole number of milliseconds a timer can hold', () => {
  assert.equal(isTimerMs(1, 1), true)
  assert.equal(isTimerMs(MAX_RUN_TIMEOUT_MS, 1), true)
  assert.equal(isTimerMs(0, 0), true)
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_RUN_TIMEOUT_MS + 1]) {
    assert.equal(isTimerMs(bad, 1), false, String(bad))
  }
  assert.doesNotThrow(() => checkMs(60_000, 'timeoutMs', 1))
  assert.throws(
    () => checkMs(0, 'timeoutMs', 1),
    (error) => code('BENCH_INVALID_SPEC')(error) && (error as Error).message.includes('timeoutMs'),
  )
})

test('an exit code is the process’s own, or 128 plus the signal that ended it', () => {
  assert.equal(exitCodeOf(0, null), 0)
  assert.equal(exitCodeOf(7, null), 7)
  assert.equal(exitCodeOf(null, 'SIGTERM'), 143)
  assert.equal(exitCodeOf(null, 'SIGKILL'), 137)
  assert.equal(exitCodeOf(null, null), 129)
})

test('what a finished run leaves behind is killed after the grace period, and the wall time stops at the exit', async (t) => {
  const dir = await scratch(t, 'bench-exec-')
  const pidFile = join(dir, 'pid')
  const outcome = await execProcess({
    argv: sleeper('sleep 20 & echo $! > "$0"; exit 0', pidFile),
    cwd: process.cwd(),
    env: {},
    killGraceMs: 600,
  })
  assert.equal(outcome.exitCode, 0)
  assert.ok(outcome.wallMs < 400, `wall ${outcome.wallMs} ms includes the cleanup`)
  assert.ok(!outcome.warnings?.some((warning) => warning.includes('timed out')))
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(await isGone(pid), `process ${pid} outlived its run`)
})

test('the bench exiting mid-run does not leave the subject running', async (t) => {
  const dir = await scratch(t, 'bench-exec-')
  const pidFile = join(dir, 'pid')
  // A bench process that starts a long run, waits until the subject has recorded its pid, then
  // exits the way a handled SIGINT does.
  const execUrl = new URL('./exec.ts', import.meta.url).href
  const script = `
    import { existsSync, readFileSync } from 'node:fs'
    import { execProcess } from ${JSON.stringify(execUrl)}
    void execProcess({
      argv: ['/bin/sh', '-c', 'echo $$ > "$0"; exec sleep 20', ${JSON.stringify(pidFile)}],
      cwd: process.cwd(),
      env: {},
    })
    const poll = setInterval(() => {
      if (existsSync(${JSON.stringify(pidFile)}) && readFileSync(${JSON.stringify(pidFile)}, 'utf8') !== '') {
        clearInterval(poll)
        process.exit(0)
      }
    }, 5)
  `
  const bench = spawn(process.execPath, [SOURCE, '--input-type=module', '-e', script], {
    stdio: 'inherit',
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    bench.once('error', reject)
    bench.once('exit', resolve)
  })
  assert.equal(exitCode, 0)
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(await isGone(pid), `subject ${pid} outlived the bench`)
})

test('SIGINT to the bench ends it with 130 and takes the subject down with it', async (t) => {
  const dir = await scratch(t, 'bench-exec-')
  const pidFile = join(dir, 'pid')
  const execUrl = new URL('./exec.ts', import.meta.url).href
  const script = `
    import { exitOnSignals } from ${JSON.stringify(HARNESS_URL)}
    import { execProcess } from ${JSON.stringify(execUrl)}
    exitOnSignals()
    await execProcess({
      argv: ['/bin/sh', '-c', 'echo $$ > "$0"; exec sleep 20', ${JSON.stringify(pidFile)}],
      cwd: process.cwd(),
      env: {},
    })
  `
  const bench = spawn(process.execPath, [SOURCE, '--input-type=module', '-e', script], {
    stdio: 'inherit',
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    bench.once('error', reject)
    bench.once('exit', resolve)
  })
  // Wait for the subject to say it is running, then interrupt the bench as a terminal would.
  let pid = Number.NaN
  for (let attempt = 0; attempt < 1000 && Number.isNaN(pid); attempt++) {
    pid = Number.parseInt(await readFile(pidFile, 'utf8').catch(() => ''), 10)
    if (Number.isNaN(pid)) await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(!Number.isNaN(pid), 'the subject never started')
  bench.kill('SIGINT')
  assert.equal(await exited, 130)
  assert.ok(await isGone(pid), `subject ${pid} outlived the interrupted bench`)
})
