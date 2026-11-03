import { type ChildProcess, type StdioOptions, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { errorMessage } from './internal/guards.ts'

/**
 * How `spawnInGroup` starts a process. `stdio` is the caller's: the bench reads a spare fd, the
 * recorder pipes stdout and stderr.
 * @public
 */
export interface SpawnInGroupOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdio: StdioOptions
  /**
   * A process that outlasts this is terminated with its whole group: SIGTERM, then SIGKILL after
   * `killGraceMs`. Default: no limit.
   */
  readonly timeoutMs?: number
  /** Terminates the group the way `timeoutMs` does when it aborts, for a caller that owns the clock. */
  readonly deadline?: AbortSignal
  /** How long a terminated group has to exit before it is killed, and how long members left behind by a process that exited get. Default: 2000. */
  readonly killGraceMs?: number
}

/**
 * How a process in its own group ended.
 * @public
 */
export interface GroupExit {
  /** `null` when a signal ended it. */
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** The timeout or the deadline passed, and the group was terminated. */
  readonly timedOut: boolean
  /** `performance.now()` when the process exited, before the rest of its group was waited for. */
  readonly endedAt: number
  /** Signals that could not be sent, other than to a group that was already gone. */
  readonly problems: readonly string[]
}

/**
 * A process started by `spawnInGroup`.
 * @public
 */
export interface GroupedChild {
  readonly child: ChildProcess
  /** Settles once the process has exited and its group is gone. Rejects if it can't be started. */
  readonly exited: Promise<GroupExit>
}

const DEFAULT_KILL_GRACE_MS = 2_000
const POLL_MS = 10
// A group that SIGKILL has not emptied by now has a member the kernel won't let go of.
const KILLED_GROUP_SETTLE_MS = 2_000

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Starts a process as the leader of its own process group, so it and everything it forks can be
 * ended together (on Windows, which has no groups, only the process itself is signalled).
 *
 * When `timeoutMs` passes or `deadline` aborts, the group gets SIGTERM, then SIGKILL after
 * `killGraceMs`. `exited` settles after the process has exited and its group has no members left:
 * members still alive `killGraceMs` after the process exited are killed, so nothing outlives a
 * finished run. If this process exits first, the group is killed on the way out. The library does
 * not handle SIGINT, SIGTERM or SIGHUP: a command-line entry point calls `exitOnSignals` so those
 * end this process normally.
 * @public
 */
export function spawnInGroup(
  command: string,
  args: readonly string[],
  options: SpawnInGroupOptions,
): GroupedChild {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const useGroup = process.platform !== 'win32'
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
    detached: useGroup,
  })
  const pid = child.pid
  const problems: string[] = []
  let timedOut = false
  let childExited = false
  let killDueAt = 0
  let killTimer: NodeJS.Timeout | undefined
  let timeoutTimer: NodeJS.Timeout | undefined

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined) return
    try {
      if (useGroup) process.kill(-pid, signal)
      else child.kill(signal)
    } catch (error) {
      // A group that is already gone (ESRCH) is what the signal was for.
      if (!hasCode(error, 'ESRCH')) {
        problems.push(`${signal} failed: ${errorMessage(error)}`)
      }
    }
  }

  // Zero asks only whether the group exists. A member that died counts as alive until its parent
  // reaps it, so callers poll rather than trust one answer.
  const groupAlive = (): boolean => {
    if (!useGroup || pid === undefined) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      return !hasCode(error, 'ESRCH')
    }
  }

  const terminate = (): void => {
    if (childExited || timedOut) return
    timedOut = true
    signalGroup('SIGTERM')
    killDueAt = performance.now() + killGraceMs
    killTimer = setTimeout(() => signalGroup('SIGKILL'), killGraceMs)
  }

  // `detached` takes the group out of the terminal's foreground, so Ctrl-C no longer reaches it.
  // `exitOnSignals` turns signals into a normal exit, and this ends the group on the way out. It
  // goes first among the `exit` listeners, so a caller's own cleanup (the recorder removing its
  // work directory) never runs while the group is still writing.
  const onParentExit = (): void => signalGroup('SIGKILL')
  process.prependListener('exit', onParentExit)

  const release = (): void => {
    clearTimeout(timeoutTimer)
    clearTimeout(killTimer)
    options.deadline?.removeEventListener('abort', terminate)
    process.off('exit', onParentExit)
  }

  // After the leader exits: let the rest of the group go until the SIGKILL that is due (a timeout
  // scheduled one, or a grace period from now), then kill what is left.
  const awaitGroupGone = async (): Promise<void> => {
    const dueAt = timedOut ? killDueAt : performance.now() + killGraceMs
    while (groupAlive() && performance.now() < dueAt) await sleep(POLL_MS)
    if (!groupAlive()) return
    signalGroup('SIGKILL')
    const giveUpAt = performance.now() + KILLED_GROUP_SETTLE_MS
    while (groupAlive() && performance.now() < giveUpAt) await sleep(POLL_MS)
    if (groupAlive()) problems.push(`process group ${pid} still had live members after SIGKILL`)
  }

  const exited = new Promise<GroupExit>((resolve, reject) => {
    child.on('error', (error) => {
      if (childExited) return
      release()
      reject(error)
    })
    child.once('exit', (exitCode, signal) => {
      const endedAt = performance.now()
      childExited = true
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      awaitGroupGone().then(
        () => {
          release()
          resolve({ exitCode, signal, timedOut, endedAt, problems: [...problems] })
        },
        (error: unknown) => {
          release()
          reject(error)
        },
      )
    })
  })

  if (options.timeoutMs !== undefined) timeoutTimer = setTimeout(terminate, options.timeoutMs)
  if (options.deadline?.aborted) terminate()
  else options.deadline?.addEventListener('abort', terminate, { once: true })

  return { child, exited }
}

/**
 * Makes SIGINT, SIGTERM and SIGHUP end this process the normal way, with exit code 128 plus the
 * signal number. `spawnInGroup` runs each child in its own process group, so a Ctrl-C at the
 * terminal no longer reaches it; exiting normally lets `spawnInGroup` kill the groups of runs in
 * flight instead of leaving them running. A command-line entry point calls this once at start-up;
 * a library never should.
 * @public
 */
export function exitOnSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => process.exit(128 + (constants.signals[signal] ?? 0)))
  }
}
