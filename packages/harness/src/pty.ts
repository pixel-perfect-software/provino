// A terminal for a child process (B23c Phase 3, D120): Jest's watch keys are read from a TTY, so a
// recording of them needs one. Node has no pty in its core and D120 takes no dependency, so a
// small relay in Python's standard library (`pty.fork`, on every macOS and Linux image) is passed
// to `/usr/bin/python3 -c` as a string, as D72's sandbox profile is. No `.py` file: the harness is
// TypeScript only.
import { constants } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { HarnessError } from './errors.ts'
import { errorMessage } from './internal/guards.ts'
import { sleep } from './internal/sleep.ts'
import { type GroupExit, spawnInGroup } from './spawn-in-group.ts'

/**
 * The interpreter D120 names: the one every macOS has, and the one Linux images have.
 * @public
 */
export const PTY_PYTHON = '/usr/bin/python3'

/**
 * The window the child sees: 40 rows by 120 columns (Jest's usage text wraps by it).
 * @public
 */
export const PTY_ROWS = 40
/** @public */
export const PTY_COLUMNS = 120

/**
 * The relay. It runs `argv` on a pseudo-terminal of its own (the child becomes a session leader,
 * so its process group is its pid), prints that pid as the first line of its stderr, and then
 * passes its stdin to the terminal and the terminal to its stdout. On SIGTERM or stdin's end it
 * signals the child's group (SIGTERM, then SIGKILL two seconds later) and exits with the child's
 * status (128 plus the signal for a child a signal ended). The child's end is polled with
 * `waitpid(WNOHANG)` on every turn of the loop, not read from the master's end of file: a
 * grandchild that inherited the terminal keeps the master open after the child is gone. Once the
 * child has ended, what the master holds is drained, the child's group (the grandchild included)
 * is killed, and the master is closed. `-I`: nothing from the working directory (a fixture's
 * `pty.py`) is imported.
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

def reap(block):
    global status
    if status is not None:
        return
    try:
        done, code = os.waitpid(pid, 0 if block else os.WNOHANG)
    except ChildProcessError:
        return
    if done == pid:
        status = code

def drain():
    # What the child wrote before it ended, read while the master has it; bounded, because a
    # grandchild that holds the terminal may go on writing.
    for _ in range(1024):
        try:
            ready, _, _ = select.select([fd], [], [], 0)
        except InterruptedError:
            continue
        if not ready:
            return
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        os.write(1, data)

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
            # Every holder of the terminal closed it: the child has ended or is ending.
            watching = [0] if 0 in watching else []
            reap(True)
    reap(False)
    if status is not None:
        drain()
        break
try:
    os.killpg(pid, signal.SIGKILL)
except OSError:
    pass
try:
    os.close(fd)
except OSError:
    pass
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
sys.exit(128 + os.WTERMSIG(status))
`

/**
 * How a terminal child ended.
 * @public
 */
export interface PtyExit {
  /** The child's exit code, or 128 plus the signal that ended it. */
  readonly exitCode: number | null
  /** The harness's deadline passed (or `kill` was called) before the child ended. */
  readonly killed: boolean
}

/**
 * What `spawnPty` and `spawnPiped` take.
 * @public
 */
export interface PtyOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Ends both groups when it aborts. A deadline for the whole session. */
  readonly deadline?: AbortSignal
  /** The interpreter. Default `/usr/bin/python3`; a test points it at a path that isn't there. */
  readonly python?: string
}

/**
 * A match for `waitFor`: text the output holds, or a search of all the output so far that returns
 * the index just past what it found, or -1 for nothing yet.
 * @public
 */
export type PtyMatch = string | ((output: string) => number)

/**
 * A child whose output is watched and whose input is typed: on a terminal (`spawnPty`) or on a
 * pipe (`spawnPiped`).
 * @public
 */
export interface PtyProcess {
  /** Types `text` at the child (its stdin, which is the terminal). */
  write(text: string): void
  /** Everything the terminal showed so far, as the terminal sent it: escape sequences included. */
  readonly output: () => string
  /**
   * Resolves once `match` is in the output (text found at or after index `from`, or a search of
   * the whole output that finds it), with the index just past the match, so the next wait starts
   * there and still sees text that came after the match in the same read. Rejects when the child
   * ends first, or the deadline passes.
   */
  waitFor(match: PtyMatch, from?: number): Promise<number>
  /** Settles when the child has ended and both groups are gone. */
  readonly exit: Promise<PtyExit>
  /** The child's process group (its pid: a session leader). */
  readonly childPgid: number
  /** The relay's process group (the child's own for `spawnPiped`, which has no relay). */
  readonly relayPgid: number
  /** Kills the child's group, then the relay's, and waits until neither has a member left. */
  kill(): Promise<void>
}

/**
 * Whether process group `pgid` has a member (`kill(-pgid, 0)`; EPERM means it exists).
 * @public
 */
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

/** The output of a child as it arrives, and the waits on it. */
/** @internal */
export interface OutputWatch {
  append(text: string): void
  /** The child has ended: every pending wait that hasn't matched rejects. */
  end(): void
  readonly output: () => string
  waitFor(match: PtyMatch, from?: number): Promise<number>
}

function matchName(match: PtyMatch): string {
  return typeof match === 'string' ? JSON.stringify(match) : 'what the predicate asked for'
}

/** @internal */
export function watchOutput(deadline: AbortSignal | undefined): OutputWatch {
  let output = ''
  let ended = false
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    append(text) {
      output += text
      changed()
    },
    end() {
      ended = true
      changed()
    },
    output: () => output,
    waitFor(match, from = 0) {
      return new Promise<number>((resolve, reject) => {
        // The index just past the match, or -1.
        const found = (): number => {
          if (typeof match !== 'string') return match(output)
          const at = output.indexOf(match, from)
          return at === -1 ? -1 : at + match.length
        }
        const settle = (): void => {
          listeners.delete(check)
          deadline?.removeEventListener('abort', onAbort)
        }
        const check = (): boolean => {
          const end = found()
          if (end !== -1) {
            settle()
            resolve(end)
            return true
          }
          if (ended) {
            settle()
            reject(
              new HarnessError(
                'HARNESS_WATCH_FAILED',
                `the child ended before its output had ${matchName(match)}. Output tail:\n${output.slice(-2000)}`,
              ),
            )
            return true
          }
          return false
        }
        const onAbort = (): void => {
          settle()
          reject(
            new HarnessError(
              'HARNESS_WATCH_FAILED',
              `the deadline passed waiting for ${matchName(match)}. Output tail:\n${output.slice(-2000)}`,
            ),
          )
        }
        if (check()) return
        listeners.add(check)
        if (deadline?.aborted === true) onAbort()
        else deadline?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

/**
 * A process's exit code as a shell gives it: its own, or 128 plus the number of the signal that
 * ended it (the relay passes the child's on the same rule), `null` only when neither is known.
 * @internal
 */
export function exitCodeOf(exit: Pick<GroupExit, 'exitCode' | 'signal'>): number | null {
  if (exit.exitCode !== null) return exit.exitCode
  if (exit.signal === null) return null
  const number = constants.signals[exit.signal]
  return number === undefined ? null : 128 + number
}

/** Forwards `deadline` to a controller of the caller's own, which `kill` also aborts. */
function linkedStop(deadline: AbortSignal | undefined): {
  readonly stop: AbortController
  readonly unlink: () => void
} {
  const stop = new AbortController()
  const abort = (): void => stop.abort()
  deadline?.addEventListener('abort', abort, { once: true })
  if (deadline?.aborted === true) abort()
  return { stop, unlink: () => deadline?.removeEventListener('abort', abort) }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

function settledOf<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

/**
 * Starts `argv` on a pseudo-terminal of 40 by 120. The relay (its own process group, by
 * `spawnInGroup`) and the child (a session leader) are both killed by `kill()`, and by `deadline`.
 * `HARNESS_PTY_UNAVAILABLE` when there is no `python3`, or no terminal to open.
 * @public
 */
export async function spawnPty(argv: readonly string[], options: PtyOptions): Promise<PtyProcess> {
  const python = options.python ?? PTY_PYTHON
  const { stop, unlink } = linkedStop(options.deadline)
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
  const exitedSettled = settledOf(exited)
  const relayPgid = child.pid
  if (relayPgid === undefined) {
    unlink()
    const settled = await exitedSettled
    throw new HarnessError(
      'HARNESS_PTY_UNAVAILABLE',
      `${python} could not be started${settled.ok ? '' : `: ${errorMessage(settled.error)}`}`,
    )
  }

  const watch = watchOutput(options.deadline)
  let errorText = ''
  let killed = false
  const decoder = new StringDecoder('utf8')
  child.stdout?.on('data', (chunk: Buffer) => watch.append(decoder.write(chunk)))
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

  const exit = exitedSettled.then((settled): PtyExit => {
    unlink()
    watch.append(decoder.end())
    watch.end()
    if (!settled.ok) throw settled.error
    return { exitCode: exitCodeOf(settled.value), killed: killed || settled.value.timedOut }
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

  return {
    write(text) {
      if (child.stdin?.writable === true) child.stdin.write(text)
    },
    output: watch.output,
    waitFor: watch.waitFor,
    exit,
    childPgid,
    relayPgid,
    async kill() {
      killed = true
      // The child's group first, by its own pgid, then the relay's through the deadline's path.
      signalGroup(childPgid, 'SIGKILL')
      stop.abort()
      await exitedSettled
      await untilGone(childPgid, 'the terminal child')
      await untilGone(relayPgid, 'the pty relay')
    },
  }
}

/**
 * Starts `argv` with no terminal (a watch fixture's `tty: false`): stdin a pipe that stays open,
 * stdout and stderr one pipe (`/bin/sh -c 'exec "$@" 2>&1'`), so the order of the two streams is
 * the order the child wrote them in. One process group, the child's own, which `kill()` and
 * `deadline` end.
 * @public
 */
export async function spawnPiped(
  argv: readonly string[],
  options: Omit<PtyOptions, 'python'>,
): Promise<PtyProcess> {
  const { stop, unlink } = linkedStop(options.deadline)
  const { child, exited } = spawnInGroup('/bin/sh', ['-c', 'exec "$@" 2>&1', 'sh', ...argv], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    deadline: stop.signal,
    killGraceMs: 3_000,
  })
  const exitedSettled = settledOf(exited)
  const pgid = child.pid
  if (pgid === undefined) {
    unlink()
    const settled = await exitedSettled
    throw new HarnessError(
      'HARNESS_WATCH_FAILED',
      `/bin/sh could not be started${settled.ok ? '' : `: ${errorMessage(settled.error)}`}`,
    )
  }
  const watch = watchOutput(options.deadline)
  let killed = false
  const decoder = new StringDecoder('utf8')
  child.stdout?.on('data', (chunk: Buffer) => watch.append(decoder.write(chunk)))
  child.stdin?.on('error', () => {
    // The child ended while text was written: the exit says why.
  })
  const exit = exitedSettled.then((settled): PtyExit => {
    unlink()
    watch.append(decoder.end())
    watch.end()
    if (!settled.ok) throw settled.error
    return { exitCode: exitCodeOf(settled.value), killed: killed || settled.value.timedOut }
  })
  exit.catch(() => undefined)
  return {
    write(text) {
      if (child.stdin?.writable === true) child.stdin.write(text)
    },
    output: watch.output,
    waitFor: watch.waitFor,
    exit,
    childPgid: pgid,
    relayPgid: pgid,
    async kill() {
      killed = true
      signalGroup(pgid, 'SIGKILL')
      stop.abort()
      await exitedSettled
      await untilGone(pgid, 'the piped child')
    },
  }
}
