import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { type GroupExit, spawnInGroup } from '@provino/harness'
import { BenchError } from './errors.ts'
import { errorMessage } from './internal/guards.ts'
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
 */
const TIMES_WRAPPER = '"$@" 3>&-; s=$?; times >&3; exit $s'

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

/**
 * The exit code to report for a process: its own, or 128 plus the signal number when a signal
 * ended it.
 * @public
 */
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  return 128 + (signal === null ? 1 : (constants.signals[signal] ?? 0))
}

/**
 * Whether `ms` is a whole number of milliseconds from `min` up to `MAX_RUN_TIMEOUT_MS`, the range
 * a timer can hold. The one rule for every timeout the bench takes.
 * @public
 */
export function isTimerMs(ms: number, min: number): boolean {
  return Number.isInteger(ms) && ms >= min && ms <= MAX_RUN_TIMEOUT_MS
}

/**
 * Throws `BENCH_INVALID_SPEC` unless `ms` passes `isTimerMs`.
 * @public
 */
export function checkMs(ms: number, name: string, min: number): void {
  if (!isTimerMs(ms, min)) {
    throw new BenchError(
      'BENCH_INVALID_SPEC',
      `${name} must be a whole number of milliseconds from ${min} to ${MAX_RUN_TIMEOUT_MS}; got ${ms}`,
    )
  }
}

/**
 * A duration for messages: whole minutes as `5 min`, anything else in seconds.
 * @public
 */
export function describeDuration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`
}

/**
 * Runs the request under a POSIX `sh` wrapper and measures it: wall time from `performance.now()`
 * around the process, user and system CPU from the `times` builtin (written to a spare fd), and
 * peak tree RSS from a 25 ms sampler. Output is discarded. Measurements that can't be taken are
 * left out and named in `warnings`; the process still runs. Not supported on Windows.
 *
 * The command runs in its own process group (`spawnInGroup`). A run that outlasts `timeoutMs` gets
 * SIGTERM for the whole group, then SIGKILL after `killGraceMs`; it is reported as exit
 * `TIMEOUT_EXIT_CODE` with a "timed out" warning, so it is kept as a failed run. The end time is
 * still taken when the shell exits, before the group is waited for. If the bench process itself
 * exits mid-run, the group is killed so no benchmark is left running.
 * @public
 */
export const execProcess: ExecProcess = async (request) => {
  if (process.platform === 'win32') {
    throw new BenchError('BENCH_UNSUPPORTED_PLATFORM', 'the bench runs commands under a POSIX sh')
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  checkMs(timeoutMs, 'timeoutMs', 1)
  if (request.killGraceMs !== undefined) checkMs(request.killGraceMs, 'killGraceMs', 0)

  const startedAt = performance.now()
  const { child, exited } = spawnInGroup('/bin/sh', ['-c', TIMES_WRAPPER, 'sh', ...request.argv], {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    timeoutMs,
    ...(request.killGraceMs === undefined ? {} : { killGraceMs: request.killGraceMs }),
  })
  const sampler = child.pid === undefined ? undefined : startRssSampler(child.pid)

  let measured: [GroupExit, string]
  try {
    measured = await Promise.all([exited, readAll(child.stdio[3])])
  } catch (cause) {
    await sampler?.stop()
    throw new BenchError('BENCH_EXEC_FAILED', `could not run ${request.argv.join(' ')}`, { cause })
  }
  const rss = await sampler?.stop()
  const [exit, timesText] = measured
  const shellExitCode = exitCodeOf(exit.exitCode, exit.signal)
  const warnings: string[] = []
  if (exit.timedOut) {
    warnings.push(
      `timed out after ${describeDuration(timeoutMs)} and was killed (the shell exited ${shellExitCode})`,
    )
  }
  for (const problem of exit.problems) warnings.push(`could not stop the process group: ${problem}`)
  const times = parseTimes(timesText)
  // A killed shell never writes its times; the timeout already says why.
  if (times === undefined && !exit.timedOut) {
    warnings.push('user and system CPU unavailable: unreadable `times` output')
  }
  if (rss?.peakMib === undefined) {
    const reason =
      rss?.lastError === undefined ? 'no sample saw the process' : errorMessage(rss.lastError)
    warnings.push(`peak tree RSS unavailable: ${reason}`)
  }
  return {
    exitCode: exit.timedOut ? TIMEOUT_EXIT_CODE : shellExitCode,
    wallMs: exit.endedAt - startedAt,
    ...(times === undefined ? {} : { cpuUserMs: times.userMs, cpuSysMs: times.sysMs }),
    ...(rss?.peakMib === undefined ? {} : { peakRssMb: rss.peakMib }),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}
