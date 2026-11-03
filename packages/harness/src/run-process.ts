import { performance } from 'node:perf_hooks'
import { spawnInGroup } from './spawn-in-group.ts'

/**
 * What `runProcess` needs. The deadline is either a time limit or a signal, so a caller (or a test)
 * can own the clock.
 * @public
 */
export interface ProcessOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** The whole process group is terminated after this long. Default: no limit. */
  readonly timeoutMs?: number
  /** The whole process group is terminated when it aborts. */
  readonly deadline?: AbortSignal
  /** How long a terminated group may take to exit before it is killed. Default: 2 s. */
  readonly killGraceMs?: number
  /** How long to wait for the output pipes after the process exits. Default: 0.5 s. */
  readonly stdioGraceMs?: number
  /** How much of the end of the output `output` keeps, in characters. Default: 4000. */
  readonly tailChars?: number
  /** Called with each chunk of output as it arrives. */
  readonly onOutput?: (chunk: string) => void
}

/**
 * How a run ended.
 * @public
 */
export interface ProcessResult {
  /** `null` when a signal ended it. */
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** The end of stdout and stderr together. */
  readonly output: string
  /** The time limit or the deadline passed and the process group was terminated. */
  readonly timedOut: boolean
  /** Milliseconds from just before the spawn to the process's exit. */
  readonly wallMs: number
  /** Signals that could not be sent to the group, other than to a group that was already gone. */
  readonly problems: readonly string[]
}

const DEFAULT_TAIL_CHARS = 4_000
const DEFAULT_STDIO_GRACE_MS = 500

/** Resolves when `closed` does, or after `graceMs`, whichever is first. */
function untilClosedOrGrace(closed: Promise<void>, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs)
    void closed.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Runs a command as the leader of its own process group (`spawnInGroup`) and captures the end of
 * its output. The deadline is checked by this function's own timers, not the child's state: it ends
 * a run that hangs, and a run whose output pipes a grandchild keeps open after the child exits
 * settles once `stdioGraceMs` has passed. It resolves for any exit, a timeout included, and rejects
 * only if the process can't be started.
 * @public
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS
  const startedAt = performance.now()
  const { child, exited } = spawnInGroup(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))

  let output = ''
  let collecting = true
  const collect = (chunk: Buffer): void => {
    if (!collecting) return
    const text = chunk.toString('utf8')
    const joined = output + text
    output = joined.length > tailChars ? joined.slice(joined.length - tailChars) : joined
    options.onOutput?.(text)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  try {
    const exit = await exited
    // The pipes get a short grace to drain; 'close' settles sooner when nothing holds them.
    await untilClosedOrGrace(closed, options.stdioGraceMs ?? DEFAULT_STDIO_GRACE_MS)
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      output,
      timedOut: exit.timedOut,
      wallMs: exit.endedAt - startedAt,
      problems: exit.problems,
    }
  } finally {
    // Pipes a grandchild still holds would keep the loop, and this promise, waiting.
    collecting = false
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}
