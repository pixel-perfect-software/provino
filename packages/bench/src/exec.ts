import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { BenchError } from './errors.ts'
import { startRssSampler } from './tree-rss.ts'

/**
 * One process to run. `env` is added on top of the bench process's own environment.
 * @public
 */
export interface ExecRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
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
  return (Number(match[1]) * 60 + Number(match[2])) * 1000
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
 * Runs the request under a POSIX `sh` wrapper and measures it: wall time from `performance.now()`
 * around the process, user and system CPU from the `times` builtin (written to a spare fd), and
 * peak tree RSS from a 25 ms sampler. Output is discarded. Measurements that can't be taken are
 * left out and named in `warnings`; the process still runs. Not supported on Windows.
 * @public
 */
export const execProcess: ExecProcess = async (request) => {
  if (process.platform === 'win32') {
    throw new BenchError('BENCH_UNSUPPORTED_PLATFORM', 'the bench runs commands under a POSIX sh')
  }
  const startedAt = performance.now()
  const child = spawn('/bin/sh', ['-c', TIMES_WRAPPER, 'sh', ...request.argv], {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  })
  const sampler = child.pid === undefined ? undefined : startRssSampler(child.pid)
  const exited = new Promise<{ exitCode: number; endedAt: number }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      resolve({ exitCode: exitCodeOf(code, signal), endedAt: performance.now() }),
    )
  })
  let result: [{ exitCode: number; endedAt: number }, string]
  try {
    result = await Promise.all([exited, readAll(child.stdio[3])])
  } catch (cause) {
    await sampler?.stop()
    throw new BenchError('BENCH_EXEC_FAILED', `could not run ${request.argv.join(' ')}`, { cause })
  }
  const rss = await sampler?.stop()
  const [{ exitCode, endedAt }, timesText] = result
  const warnings: string[] = []
  const times = parseTimes(timesText)
  if (times === undefined)
    warnings.push('user and system CPU unavailable: unreadable `times` output')
  if (rss?.peakMib === undefined) {
    const reason =
      rss?.lastError instanceof Error ? rss.lastError.message : 'no sample saw the process'
    warnings.push(`peak tree RSS unavailable: ${reason}`)
  }
  return {
    exitCode,
    wallMs: endedAt - startedAt,
    ...(times === undefined ? {} : { cpuUserMs: times.userMs, cpuSysMs: times.sysMs }),
    ...(rss?.peakMib === undefined ? {} : { peakRssMb: rss.peakMib }),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}
