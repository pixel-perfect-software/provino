import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { BenchError } from './errors.ts'
import { startRssSampler } from './tree-rss.ts'

/**
 * How long one run may take before it is killed: 30 minutes.
 * @public
 */
export const DEFAULT_RUN_TIMEOUT_MS: number = 30 * 60 * 1000

/**
 * The longest timeout a run can have: `setTimeout` fires at once for anything above 2^31 - 1 ms
 * (about 24.8 days).
 * @public
 */
export const MAX_RUN_TIMEOUT_MS: number = 2 ** 31 - 1

/**
 * The exit code of a run that was killed for taking too long, as `timeout(1)` reports it.
 * @public
 */
export const TIMEOUT_EXIT_CODE = 124

const DEFAULT_KILL_GRACE_MS = 2000

/**
 * One process to run. `env` is added on top of the bench process's own environment.
 * @public
 */
export interface ExecRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /**
   * A run that lasts longer is killed with its whole process group and reported as exit
   * `TIMEOUT_EXIT_CODE`. A whole number of milliseconds from 1 to `MAX_RUN_TIMEOUT_MS`. Default
   * `DEFAULT_RUN_TIMEOUT_MS`.
   */
  readonly timeoutMs?: number
  /**
   * How long a timed-out group has to exit after SIGTERM before it gets SIGKILL, in milliseconds.
   * Default 2000.
   */
  readonly killGraceMs?: number
}

/**
 * What one run of a process measured.
 * @public
 */
export interface ExecOutcome {
  readonly exitCode: number
  /** Wall time from just before the spawn to the process's exit. */
  readonly wallMs: number
  /** User CPU of the command and everything it waited for. */
  readonly cpuUserMs?: number
  readonly cpuSysMs?: number
  /** Peak RSS in MiB, summed over the process tree. */
  readonly peakRssMb?: number
  /** Measurements that couldn't be taken, and why. */
  readonly warnings?: readonly string[]
}

/**
 * Runs a process and measures it. `runBench` takes one so unit tests can use a fake; the default
 * is `execProcess`.
 * @public
 */
export type ExecProcess = (request: ExecRequest) => Promise<ExecOutcome>

/**
 * The shell script that wraps every timed command: run it with fd 3 closed so no child can hold
 * the pipe open, then write the `times` builtin's output to the shell's own fd 3.
 * @public
 */
export const TIMES_WRAPPER = '"$@" 3>&-; s=$?; times >&3; exit $s'

const TIME_PATTERN = /(\d+)m(\d+(?:\.\d+)?)s/g

function toMs(match: RegExpExecArray): number {
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  // dash up to 0.5.10.2 (Ubuntu 20.04, Debian 10) prints minutes = total / 60 but seconds = the
  // whole total, so 100 s is `1m100.000000s`. A correct shell never prints 60 seconds or more,
  // so a seconds field that large is the total and the minutes are redundant.
  return (seconds >= 60 ? seconds : minutes * 60 + seconds) * 1000
}

/**
 * Parses the POSIX `times` builtin: line 1 is the shell's own user and system time, line 2 is its
 * children's, each as `XmY.ZZZs`. Returns the children's, which is the command and everything it
 * waited for, or `undefined` if the second line doesn't hold two times.
 * @public
 */
export function parseTimes(
  text: string,
): { readonly userMs: number; readonly sysMs: number } | undefined {
  const line = text.trim().split('\n')[1]
  if (line === undefined) return undefined
  const times = [...line.matchAll(TIME_PATTERN)]
  const [user, sys] = times
  if (times.length !== 2 || user === undefined || sys === undefined) return undefined
  return { userMs: toMs(user), sysMs: toMs(sys) }
}

async function readAll(stream: unknown): Promise<string> {
  if (!(stream instanceof Readable)) return ''
  stream.setEncoding('utf8')
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  return 128 + (signal === null ? 1 : (constants.signals[signal] ?? 0))
}

/**
 * Makes SIGINT, SIGTERM and SIGHUP end this process the normal way, with exit code 128 plus the
 * signal number. `execProcess` runs each subject in its own process group, so a Ctrl-C at the
 * terminal no longer reaches it; exiting normally lets `execProcess` kill the group of a run in
 * flight instead of leaving a benchmark running. The CLI calls this once at start-up.
 * @public
 */
export function exitOnSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => process.exit(128 + (constants.signals[signal] ?? 0)))
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

// The subject runs as the leader of its own process group, so one signal reaches everything it
// started. A group that is already gone (ESRCH) is fine; any other failure is reported.
function signalGroup(pid: number, signal: NodeJS.Signals, problems: string[]): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!hasCode(error, 'ESRCH')) {
      problems.push(`${signal} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return !hasCode(error, 'ESRCH')
  }
}

// Waits until the group has no members left or the grace period is over, whichever comes first.
// `graceOver` settles after the SIGKILL has been sent. A dead member counts as alive until its
// parent reaps it, so this polls rather than trusting the first answer.
async function groupExit(pid: number, graceOver: Promise<void>): Promise<void> {
  let over = false
  void graceOver.then(() => {
    over = true
  })
  while (!over && groupAlive(pid)) await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

function checkMs(value: number, name: string, min: number): void {
  if (!Number.isInteger(value) || value < min || value > MAX_RUN_TIMEOUT_MS) {
    throw new BenchError(
      'BENCH_INVALID_SPEC',
      `${name} must be a whole number of milliseconds from ${min} to ${MAX_RUN_TIMEOUT_MS}; got ${value}`,
    )
  }
}

function describeDuration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`
}

/**
 * Runs the request under a POSIX `sh` wrapper and measures it: wall time from `performance.now()`
 * around the process, user and system CPU from the `times` builtin (written to a spare fd), and
 * peak tree RSS from a 25 ms sampler. Output is discarded. Measurements that can't be taken are
 * left out and named in `warnings`; the process still runs. Not supported on Windows.
 *
 * The command runs in its own process group. A run that outlasts `timeoutMs` gets SIGTERM for the
 * whole group, then SIGKILL after `killGraceMs`; it is reported as exit `TIMEOUT_EXIT_CODE` with a
 * "timed out" warning, so it is kept as a failed run. The end time is still taken when the shell
 * exits. If the bench process itself exits mid-run, the group is killed so no benchmark is left
 * running.
 * @public
 */
export const execProcess: ExecProcess = async (request) => {
  if (process.platform === 'win32') {
    throw new BenchError('BENCH_UNSUPPORTED_PLATFORM', 'the bench runs commands under a POSIX sh')
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const killGraceMs = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  checkMs(timeoutMs, 'timeoutMs', 1)
  checkMs(killGraceMs, 'killGraceMs', 0)

  const startedAt = performance.now()
  const child = spawn('/bin/sh', ['-c', TIMES_WRAPPER, 'sh', ...request.argv], {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    detached: true,
  })
  const pid = child.pid
  const sampler = pid === undefined ? undefined : startRssSampler(pid)
  const exited = new Promise<{ exitCode: number; endedAt: number }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      resolve({ exitCode: exitCodeOf(code, signal), endedAt: performance.now() }),
    )
  })

  const killProblems: string[] = []
  let timedOut = false
  let graceOver: Promise<void> = Promise.resolve()
  let graceTimer: NodeJS.Timeout | undefined
  const timeoutTimer =
    pid === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          signalGroup(pid, 'SIGTERM', killProblems)
          graceOver = new Promise((resolve) => {
            graceTimer = setTimeout(() => {
              signalGroup(pid, 'SIGKILL', killProblems)
              resolve()
            }, killGraceMs)
          })
        }, timeoutMs)
  // The group has its own session, so a Ctrl-C at the terminal no longer reaches it. The CLI turns
  // signals into a normal exit (`exitOnSignals`), and this kills the group on the way out.
  const killOnExit = (): void => {
    if (pid !== undefined) signalGroup(pid, 'SIGKILL', killProblems)
  }
  process.once('exit', killOnExit)

  let result: [{ exitCode: number; endedAt: number }, string]
  try {
    result = await Promise.all([exited, readAll(child.stdio[3])])
    // The shell is gone, but anything that ignored SIGTERM gets the rest of the grace period and
    // then SIGKILL, so the next run never starts beside a leftover from this one.
    if (timedOut && pid !== undefined) await groupExit(pid, graceOver)
  } catch (cause) {
    await sampler?.stop()
    throw new BenchError('BENCH_EXEC_FAILED', `could not run ${request.argv.join(' ')}`, { cause })
  } finally {
    clearTimeout(timeoutTimer)
    clearTimeout(graceTimer)
    process.off('exit', killOnExit)
  }
  const rss = await sampler?.stop()
  const [{ exitCode, endedAt }, timesText] = result
  const warnings: string[] = []
  if (timedOut) {
    warnings.push(
      `timed out after ${describeDuration(timeoutMs)} and was killed (the shell exited ${exitCode})`,
    )
  }
  for (const problem of killProblems) warnings.push(`could not stop the timed-out run: ${problem}`)
  const times = parseTimes(timesText)
  // A killed shell never writes its times; the timeout already says why.
  if (times === undefined && !timedOut) {
    warnings.push('user and system CPU unavailable: unreadable `times` output')
  }
  if (rss?.peakMib === undefined) {
    const reason =
      rss?.lastError instanceof Error ? rss.lastError.message : 'no sample saw the process'
    warnings.push(`peak tree RSS unavailable: ${reason}`)
  }
  return {
    exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
    wallMs: endedAt - startedAt,
    ...(times === undefined ? {} : { cpuUserMs: times.userMs, cpuSysMs: times.sysMs }),
    ...(rss?.peakMib === undefined ? {} : { peakRssMb: rss.peakMib }),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}
