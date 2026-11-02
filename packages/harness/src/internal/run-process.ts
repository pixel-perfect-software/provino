import { spawn } from 'node:child_process'

/** How a run ended. */
export interface ProcessResult {
  /** `null` when a signal ended it, or when it never reported an exit. */
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** The end of stdout and stderr together. */
  readonly output: string
  /** The deadline passed and the process group was terminated. */
  readonly timedOut: boolean
}

/** What `runProcess` needs. The deadline is a signal, so a caller (or a test) owns the clock. */
export interface ProcessOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** When it aborts, the whole process group is terminated. */
  readonly deadline: AbortSignal
  /** How long a terminated group may take to exit before it is killed. Default: 2 s. */
  readonly killGraceMs?: number
  /** How long to wait for the output pipes after the process exits. Default: 0.5 s. */
  readonly stdioGraceMs?: number
  /** Called with each chunk of output as it arrives. */
  readonly onOutput?: (chunk: string) => void
}

const OUTPUT_TAIL_CHARS = 4_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_STDIO_GRACE_MS = 500

/** Signals that end this process; the child's group must not outlive it. */
const PARENT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text
}

/**
 * Runs `node <args>` as the leader of its own process group, so a runner and the workers it forks
 * can be ended together. The deadline is checked by this function's own timers, not the child's
 * state: it ends a run that hangs, and a run whose output pipes a grandchild keeps open after the
 * child exits settles once `stdioGraceMs` has passed. It resolves for any exit, a timeout
 * included, and rejects only if the process can't be started.
 * @internal
 */
export function runProcess(
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const stdioGraceMs = options.stdioGraceMs ?? DEFAULT_STDIO_GRACE_MS
  // Windows has no process groups to signal; there the child alone is ended.
  const useGroup = process.platform !== 'win32'

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useGroup,
    })

    let output = ''
    let timedOut = false
    let exited = false
    let settled = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let killTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        if (useGroup) process.kill(-pid, signal)
        else child.kill(signal)
      } catch {
        // The group is already gone, so there is nothing left to signal.
      }
    }

    // `detached` takes the child out of the terminal's foreground group, so Ctrl-C no longer
    // reaches it. These handlers end the group with this process instead of orphaning it.
    const onParentExit = (): void => {
      if (!exited) signalGroup('SIGKILL')
    }
    const onParentSignal = (signal: NodeJS.Signals): void => {
      detach()
      signalGroup('SIGKILL')
      process.kill(process.pid, signal)
    }

    const detach = (): void => {
      clearTimeout(killTimer)
      clearTimeout(graceTimer)
      options.deadline.removeEventListener('abort', onAbort)
      process.off('exit', onParentExit)
      for (const signal of PARENT_SIGNALS) process.off(signal, onParentSignal)
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      detach()
      // After a timeout nothing in the group may outlive the run, a straggler that closed its pipes
      // included.
      if (timedOut) signalGroup('SIGKILL')
      // Pipes a grandchild still holds would keep the loop, and this promise, waiting.
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ exitCode, signal: exitSignal, output, timedOut })
    }

    const onAbort = (): void => {
      if (settled || exited) return
      timedOut = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL')
        graceTimer = setTimeout(finish, stdioGraceMs)
      }, killGraceMs)
    }

    const collect = (chunk: Buffer): void => {
      if (settled) return
      const text = chunk.toString('utf8')
      output = tail(output + text)
      options.onOutput?.(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      detach()
      reject(error)
    })
    child.on('exit', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      // The pipes get a short grace to drain; 'close' settles sooner when nothing holds them.
      clearTimeout(killTimer)
      clearTimeout(graceTimer)
      graceTimer = setTimeout(finish, stdioGraceMs)
    })
    child.on('close', finish)

    process.once('exit', onParentExit)
    for (const signal of PARENT_SIGNALS) process.once(signal, onParentSignal)
    if (options.deadline.aborted) onAbort()
    else options.deadline.addEventListener('abort', onAbort, { once: true })
  })
}
