import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What a finished command left. */
export interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** stdout, then stderr, then what went wrong if the command never ran or didn't end. */
  readonly output: string
  /**
   * Set when the process could not be started (`ENOENT`), was killed for outrunning its deadline
   * (`ETIMEDOUT`) or overflowed its buffer. `status` is `null` then, and `stdout` and
   * `stderr` hold what arrived before.
   */
  readonly error: (Error & { readonly code?: string }) | undefined
}

/**
 * Runs a command to its end and returns its exit status, its stdout and stderr apart, and both
 * joined as `output`. `FORCE_COLOR` is dropped so the output is plain text. A command that cannot be
 * started, or doesn't end within `timeoutMs`, comes back with `status` `null`, the reason in `error`
 * and in `output`: a failure to run is never printed as an empty result.
 * @internal
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): CommandResult {
  const timeoutMs = options.timeoutMs ?? 300_000
  const result = spawnSync(command, [...args], {
    ...spawnOptions(options),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  // A command that never started has no streams at all (`null`, not empty strings).
  return finished(
    command,
    timeoutMs,
    result.status,
    result.stdout ?? '',
    result.stderr ?? '',
    result.error as CommandResult['error'],
  )
}

/**
 * `runCommand` that doesn't hold the process: the same result, for commands that can run beside
 * each other (a pool of `pnpm pack`s, a lint beside the API Extractor).
 * @internal
 */
export function runCommandAsync(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 300_000
  return new Promise((resolve) => {
    const child = spawn(command, [...args], spawnOptions(options))
    let stdout = ''
    let stderr = ''
    let error: CommandResult['error']
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const deadline = setTimeout(() => {
      error = Object.assign(new Error(`${command} ETIMEDOUT`), { code: 'ETIMEDOUT' })
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (cause: CommandResult['error']) => {
      error ??= cause
    })
    // `close`, not `exit`: the streams have ended, so nothing the command wrote is lost.
    child.once('close', (status) => {
      clearTimeout(deadline)
      // As `spawnSync` has it: no status when the command never ran or was killed for its deadline.
      resolve(
        finished(command, timeoutMs, error === undefined ? status : null, stdout, stderr, error),
      )
    })
  })
}

/** What `runCommand` takes: where to run, how long to wait, and the environment. */
interface CommandOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

/** `FORCE_COLOR` is dropped and `NO_COLOR` set, so the output is plain text. */
function spawnOptions(options: CommandOptions): {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['ignore', 'pipe', 'pipe']
} {
  const { FORCE_COLOR: _color, ...inherited } = options.env ?? process.env
  return {
    cwd: options.cwd,
    env: { ...inherited, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
}

function finished(
  command: string,
  timeoutMs: number,
  status: number | null,
  stdout: string,
  stderr: string,
  error: CommandResult['error'],
): CommandResult {
  const reason =
    error === undefined
      ? ''
      : `\n${command}: ${error.code === 'ETIMEDOUT' ? `did not end within ${timeoutMs} ms and was killed` : error.message}\n`
  return { status, stdout, stderr, output: `${stdout}${stderr}${reason}`, error }
}

/**
 * The script a package installed in the workspace names as its `bin`. A bin-only package (attw's
 * CLI) has no entry to resolve, and another may not export its package.json, so this reads
 * `node_modules/<package>/package.json` from this directory up, as Node would find the package.
 * @internal
 */
export function binScript(packageName: string, bin: string): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', packageName, 'package.json')
    if (existsSync(path)) {
      const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const field =
        typeof manifest === 'object' && manifest !== null && 'bin' in manifest
          ? manifest.bin
          : undefined
      const relative =
        typeof field === 'string'
          ? field
          : typeof field === 'object' && field !== null
            ? (field as Record<string, unknown>)[bin]
            : undefined
      if (typeof relative !== 'string') throw new Error(`${packageName} has no bin "${bin}"`)
      return join(dirname(path), relative)
    }
    if (dirname(dir) === dir) throw new Error(`${packageName} is not installed`)
  }
}
