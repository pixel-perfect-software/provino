// What jest-changed-files 30.5.1 gets from execa 5.1.1, over `node:child_process`: run a command,
// resolve its stdout without the final newline (`stripFinalNewline`), and reject a failure with
// execa's message (`lib/error.js` `makeError`: `Command failed with exit code N: <cmd>`, then
// stderr, then stdout), which Jest prints. No dependency (D115: execa is Jest's choice, and Node's
// own spawn is the faster option for the same commands).
import { spawn } from 'node:child_process'

/** A command that failed, as execa reports it. */
export interface CommandError extends Error {
  readonly command: string
  readonly exitCode: number | undefined
  readonly signal: NodeJS.Signals | undefined
  readonly stdout: string
  readonly stderr: string
}

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

/** What a run of a command can be told: where, with what environment, and a look at the first chunk. */
export interface RunOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** Called with stdout's first chunk; returning true kills the command (sl's steam-locomotive check). */
  readonly firstChunk?: (chunk: string) => boolean
}

/** The outcome of a command a `firstChunk` check killed: no output, no error. */
export const CANCELLED: unique symbol = Symbol('cancelled')

/**
 * Runs `file args` and resolves with its stdout (the final newline stripped), or `CANCELLED` when
 * `firstChunk` asked for the kill. A command that can't start or ends badly rejects with execa's
 * message.
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<string | typeof CANCELLED> {
  const command = [file, ...args].join(' ')
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let cancelled = false
    let spawnError: (Error & { code?: unknown }) | undefined
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let first = true
    child.stdout.on('data', (chunk: string) => {
      if (first) {
        first = false
        if (options.firstChunk?.(chunk) === true) {
          cancelled = true
          child.kill()
          return
        }
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    let settled = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (cancelled) {
        resolvePromise(CANCELLED)
        return
      }
      const out = stripFinalNewline(stdout)
      const err = stripFinalNewline(stderr)
      if (spawnError === undefined && exitCode === 0) {
        resolvePromise(out)
        return
      }
      const code = typeof spawnError?.code === 'string' ? spawnError.code : undefined
      const head = `Command ${prefixOf(code, signal ?? undefined, exitCode ?? undefined)}: ${command}`
      const short = spawnError === undefined ? head : `${head}\n${spawnError.message}`
      const error = Object.assign(new Error([short, err, out].filter(Boolean).join('\n')), {
        command,
        exitCode: exitCode ?? undefined,
        signal: signal ?? undefined,
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
