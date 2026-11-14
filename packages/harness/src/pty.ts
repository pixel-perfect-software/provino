// A terminal for a child process (B23c Phase 3, D120): Jest's watch keys are read from a TTY, so a
// recording of them needs one. Node has no pty in its core and D120 takes no dependency, so a
// small relay in Python's standard library (`pty.fork`, on every macOS and Linux image) is passed
// to `/usr/bin/python3 -c` as a string, as D72's sandbox profile is. No `.py` file: the harness is
// TypeScript only.
import { StringDecoder } from 'node:string_decoder'
import { HarnessError } from './errors.ts'
import { errorMessage } from './internal/guards.ts'
import { spawnInGroup } from './spawn-in-group.ts'

/** The interpreter D120 names: the one every macOS has, and the one Linux images have. */
export const PTY_PYTHON = '/usr/bin/python3'

/** The window the child sees: 40 rows by 120 columns (Jest's usage text wraps by it). */
export const PTY_ROWS = 40
export const PTY_COLUMNS = 120

/**
 * The relay. It runs `argv` on a pseudo-terminal of its own (the child becomes a session leader,
 * so its process group is its pid), prints that pid as the first line of its stderr, and then
 * passes its stdin to the terminal and the terminal to its stdout. On SIGTERM or stdin's end it
 * signals the child's group (SIGTERM, then SIGKILL two seconds later) and exits with the child's
 * status (128 plus the signal for a child a signal ended). `-I`: nothing from the working
 * directory (a fixture's `pty.py`) is imported.
 */
const RELAY = `
import fcntl, os, pty, select, signal, struct, sys, termios, time

rows, cols = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
try:
    pid, fd = pty.fork()
except OSError as error:
    sys.stderr.write("PTY_UNAVAILABLE " + str(error) + "\\n")
    sys.exit(127)
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    except OSError as error:
        os.write(2, ("exec failed: " + str(error) + "\\n").encode())
        os._exit(127)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
sys.stderr.write(str(pid) + "\\n")
sys.stderr.flush()

kill_at = None
def end(*_):
    global kill_at
    if kill_at is None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
        kill_at = time.monotonic() + 2
signal.signal(signal.SIGTERM, end)
signal.signal(signal.SIGHUP, end)

watching = [0, fd]
status = None
while True:
    if kill_at is not None and time.monotonic() >= kill_at:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        kill_at = time.monotonic() + 2
    try:
        ready, _, _ = select.select(watching, [], [], 0.1)
    except InterruptedError:
        continue
    for source in ready:
        try:
            data = os.read(source, 65536)
        except OSError:
            data = b""
        if source == 0:
            if data:
                os.write(fd, data)
            else:
                watching.remove(0)
                end()
        elif data:
            os.write(1, data)
        else:
            watching = [0] if 0 in watching else []
            status = os.waitpid(pid, 0)[1]
    if status is not None:
        break
try:
    os.killpg(pid, signal.SIGKILL)
except OSError:
    pass
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
sys.exit(128 + os.WTERMSIG(status))
`

/** How a terminal child ended. */
export interface PtyExit {
  /** The child's exit code, or 128 plus the signal that ended it. */
  readonly exitCode: number | null
  /** The harness's deadline passed (or `kill` was called) before the child ended. */
  readonly killed: boolean
}

/** What `spawnPty` takes. */
export interface PtyOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Ends both groups when it aborts. A deadline for the whole session. */
  readonly deadline?: AbortSignal
  /** The interpreter. Default `/usr/bin/python3`; a test points it at a path that isn't there. */
  readonly python?: string
}

/** A match for `waitFor`: text the output holds, or a test of all the output so far. */
export type PtyMatch = string | ((output: string) => boolean)

/** A child on a terminal. */
export interface PtyProcess {
  /** Types `text` at the child (its stdin, which is the terminal). */
  write(text: string): void
  /** Everything the terminal showed so far, as the terminal sent it: escape sequences included. */
  readonly output: () => string
  /**
   * Resolves once `match` is in the output (text found at or after index `from`, or a predicate
   * true of the whole output), with the output's length at that moment, so the next wait can start
   * there. Rejects when the child ends first, or the deadline passes.
   */
  waitFor(match: PtyMatch, from?: number): Promise<number>
  /** Settles when the child has ended and both groups are gone. */
  readonly exit: Promise<PtyExit>
  /** The child's process group (its pid: a session leader). */
  readonly childPgid: number
  /** The relay's process group. */
  readonly relayPgid: number
  /** Kills the child's group, then the relay's, and waits until neither has a member left. */
  kill(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whether process group `pgid` has a member (`kill(-pgid, 0)`; EPERM means it exists). */
export function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Gone already, which is what the signal was for.
  }
}

const GROUP_SETTLE_MS = 3_000

/** Waits for a group to empty, killing what is left once. */
async function untilGone(pgid: number, label: string): Promise<void> {
  const until = Date.now() + GROUP_SETTLE_MS
  while (groupExists(pgid) && Date.now() < until) await sleep(10)
  if (!groupExists(pgid)) return
  signalGroup(pgid, 'SIGKILL')
  const last = Date.now() + GROUP_SETTLE_MS
  while (groupExists(pgid) && Date.now() < last) await sleep(10)
  if (groupExists(pgid)) {
    throw new HarnessError('HARNESS_PTY_LEAK', `${label} (group ${pgid}) still has a process`)
  }
}

/**
 * Starts `argv` on a pseudo-terminal of 40 by 120. The relay (its own process group, by
 * `spawnInGroup`) and the child (a session leader) are both killed by `kill()`, and by `deadline`.
 * `HARNESS_PTY_UNAVAILABLE` when there is no `python3`, or no terminal to open.
 */
export async function spawnPty(argv: readonly string[], options: PtyOptions): Promise<PtyProcess> {
  const python = options.python ?? PTY_PYTHON
  const stop = new AbortController()
  const abort = (): void => stop.abort()
  options.deadline?.addEventListener('abort', abort, { once: true })
  if (options.deadline?.aborted) abort()
  const { child, exited } = spawnInGroup(
    python,
    ['-I', '-c', RELAY, String(PTY_ROWS), String(PTY_COLUMNS), ...argv],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      deadline: stop.signal,
      killGraceMs: 3_000,
    },
  )
  // `spawnInGroup` rejects `exited` when the interpreter can't start; hold it so a rejection
  // before anyone awaits isn't unhandled.
  const exitedSettled = exited.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const relayPgid = child.pid
  if (relayPgid === undefined) {
    options.deadline?.removeEventListener('abort', abort)
    const settled = await exitedSettled
    throw new HarnessError(
      'HARNESS_PTY_UNAVAILABLE',
      `${python} could not be started${settled.ok ? '' : `: ${errorMessage(settled.error)}`}`,
    )
  }

  let output = ''
  let errorText = ''
  let childEnded = false
  let killed = false
  const decoder = new StringDecoder('utf8')
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of [...listeners]) listener()
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    output += decoder.write(chunk)
    changed()
  })
  // stderr: the child's pid on its first line, then the relay's own complaints.
  let resolvePid: (pid: number) => void = () => {}
  const pidLine = new Promise<number>((resolve) => {
    resolvePid = resolve
  })
  let pidSeen = false
  child.stderr?.on('data', (chunk: Buffer) => {
    errorText += chunk.toString('utf8')
    const newline = errorText.indexOf('\n')
    if (!pidSeen && newline !== -1) {
      pidSeen = true
      resolvePid(Number.parseInt(errorText.slice(0, newline), 10))
    }
  })
  child.stdin?.on('error', () => {
    // The relay ended while a key was being written: the exit says why.
  })

  const exit = exitedSettled.then(async (settled): Promise<PtyExit> => {
    childEnded = true
    options.deadline?.removeEventListener('abort', abort)
    output += decoder.end()
    changed()
    if (!settled.ok) throw settled.error
    return { exitCode: settled.value.exitCode, killed: killed || settled.value.timedOut }
  })
  // The exit promise is also the way a failed start is seen.
  exit.catch(() => undefined)

  const started = await Promise.race([pidLine, exitedSettled.then(() => undefined)])
  if (started === undefined || Number.isNaN(started)) {
    await exitedSettled
    throw new HarnessError(
      'HARNESS_PTY_UNAVAILABLE',
      `${python} ran the pty relay, but it never reported a child: ${errorText.trim() || 'no output on stderr'}`,
    )
  }
  const childPgid = started

  const kill = async (): Promise<void> => {
    killed = true
    // The child's group first, by its own pgid, then the relay's through the deadline's path.
    signalGroup(childPgid, 'SIGKILL')
    stop.abort()
    await exitedSettled
    await untilGone(childPgid, 'the terminal child')
    await untilGone(relayPgid, 'the pty relay')
  }

  return {
    write(text) {
      if (child.stdin?.writable === true) child.stdin.write(text)
    },
    output: () => output,
    waitFor(match, from = 0) {
      return new Promise<number>((resolve, reject) => {
        const found = (): boolean =>
          typeof match === 'string' ? output.indexOf(match, from) !== -1 : match(output)
        const check = (): boolean => {
          if (found()) {
            listeners.delete(check)
            options.deadline?.removeEventListener('abort', onAbort)
            resolve(output.length)
            return true
          }
          if (childEnded) {
            listeners.delete(check)
            options.deadline?.removeEventListener('abort', onAbort)
            reject(
              new HarnessError(
                'HARNESS_WATCH_FAILED',
                `the terminal child ended before its output had ${typeof match === 'string' ? JSON.stringify(match) : 'what the predicate asked for'}. Output tail:\n${output.slice(-2000)}`,
              ),
            )
            return true
          }
          return false
        }
        const onAbort = (): void => {
          listeners.delete(check)
          reject(
            new HarnessError(
              'HARNESS_WATCH_FAILED',
              `the deadline passed waiting for ${typeof match === 'string' ? JSON.stringify(match) : 'the predicate'}. Output tail:\n${output.slice(-2000)}`,
            ),
          )
        }
        if (check()) return
        listeners.add(check)
        if (options.deadline?.aborted) onAbort()
        else options.deadline?.addEventListener('abort', onAbort, { once: true })
      })
    },
    exit,
    childPgid,
    relayPgid,
    kill,
  }
}
