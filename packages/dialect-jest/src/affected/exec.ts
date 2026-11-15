// What jest-changed-files 30.5.1 gets from execa 5.1.1, over `node:child_process`: run a command,
// resolve its stdout without the final newline (`stripFinalNewline`), and reject a failure with
// execa's message (`lib/error.js` `makeError`: `Command failed with exit code N: <cmd>`, then
// stderr, then stdout), which Jest prints. No dependency (D115: execa is Jest's choice, and Node's
// own spawn is the faster option for the same commands).
//
// Two differences from execa, on purpose: stdin is `ignore` where execa leaves an open pipe (a
// command that waited on its stdin would hang a run there; none of Jest's does, so nothing else
// changes), and a command past `maxBuffer` is killed as well as reported (execa only stops reading).
import { type ChildProcess, spawn } from 'node:child_process'

/** The code of every failure this module reports: what `provino jest` prints as Jest does. */
export const SCM_COMMAND_FAILED = 'JEST_SCM_COMMAND_FAILED' as const

/** A command that failed, as execa reports it. */
export interface CommandError extends Error {
  readonly code: typeof SCM_COMMAND_FAILED
  readonly command: string
  readonly exitCode: number | undefined
  readonly signal: NodeJS.Signals | undefined
  readonly stdout: string
  readonly stderr: string
}

/** execa 5.1.1's `DEFAULT_MAX_BUFFER` (`index.js` L15): 100 MB of each stream. */
export const MAX_BUFFER: number = 1000 * 1000 * 100

/** execa's `stripFinalNewline`: one trailing `\n` (or `\r\n`). */
function stripFinalNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

/** execa's `getErrorPrefix`, for the cases a plain spawn can meet. */
function prefixOf(
  code: string | undefined,
  signal: string | undefined,
  exitCode: number | undefined,
): string {
  if (code !== undefined) return `failed with ${code}`
  if (signal !== undefined) return `was killed with ${signal}`
  if (exitCode !== undefined) return `failed with exit code ${exitCode}`
  return 'failed'
}

/** What a run of a command can be told. */
export interface RunOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** Called with stdout's first chunk; returning true kills the command (sl's steam-locomotive check). */
  readonly firstChunk?: (chunk: string) => boolean
  /** Aborting kills the command; it resolves `CANCELLED` once the process has been reaped. */
  readonly signal?: AbortSignal
  /** The bytes of a stream past which the command fails as execa's does. Default `MAX_BUFFER`. */
  readonly maxBuffer?: number
}

/** The outcome of a command that was cancelled (by `firstChunk` or `signal`): no output, no error. */
export const CANCELLED: unique symbol = Symbol('cancelled')

/**
 * Runs `file args` and resolves with its stdout (the final newline stripped), or `CANCELLED`. A
 * command that can't start, ends badly or writes more than `maxBuffer` rejects with execa's
 * message and `code` `JEST_SCM_COMMAND_FAILED`. It settles only once the process has exited and
 * its streams have closed, so a killed command is reaped before the caller moves on.
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<string | typeof CANCELLED> {
  const command = [file, ...args].join(' ')
  const maxBuffer = options.maxBuffer ?? MAX_BUFFER
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted === true) {
      resolvePromise(CANCELLED)
      return
    }
    let stdout = ''
    let stderr = ''
    let cancelled = false
    let overflowed = false
    let spawnError: (Error & { code?: unknown }) | undefined
    const child: ChildProcess = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const cancel = (): void => {
      cancelled = true
      child.kill()
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // get-stream counts each stream's bytes (a chunk's UTF-8 length), and fails past the limit.
    const bytes = { out: 0, err: 0 }
    const grow = (stream: 'out' | 'err', current: string, chunk: string): string => {
      bytes[stream] += Buffer.byteLength(chunk)
      if (!overflowed && bytes[stream] > maxBuffer) {
        overflowed = true
        child.kill()
      }
      return current + chunk
    }
    let first = true
    child.stdout?.on('data', (chunk: string) => {
      if (first) {
        first = false
        if (options.firstChunk?.(chunk) === true) {
          cancel()
          return
        }
      }
      if (!cancelled) stdout = grow('out', stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      if (!cancelled) stderr = grow('err', stderr, chunk)
    })
    let settled = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', cancel)
      if (cancelled) {
        resolvePromise(CANCELLED)
        return
      }
      const out = stripFinalNewline(stdout)
      const err = stripFinalNewline(stderr)
      if (spawnError === undefined && !overflowed && exitCode === 0) {
        resolvePromise(out)
        return
      }
      let short: string
      if (overflowed) {
        // execa: get-stream's `MaxBufferError` is the error, with no code, signal or exit code.
        short = `Command failed: ${command}\nmaxBuffer exceeded`
      } else {
        const code = typeof spawnError?.code === 'string' ? spawnError.code : undefined
        const head = `Command ${prefixOf(code, signal ?? undefined, exitCode ?? undefined)}: ${command}`
        short = spawnError === undefined ? head : `${head}\n${spawnError.message}`
      }
      const error = Object.assign(new Error([short, err, out].filter(Boolean).join('\n')), {
        code: SCM_COMMAND_FAILED,
        command,
        exitCode: overflowed ? undefined : (exitCode ?? undefined),
        signal: overflowed ? undefined : (signal ?? undefined),
        stdout: out,
        stderr: err,
      }) satisfies CommandError
      reject(error)
    }
    child.on('error', (error) => {
      spawnError = error
      // A command that never started (ENOENT, a missing cwd) has no exit to wait for.
      if (child.pid === undefined) finish(null, null)
    })
    child.on('close', finish)
  })
}
