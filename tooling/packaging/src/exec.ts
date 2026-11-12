import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What a finished command left. */
export interface CommandResult {
  readonly status: number | null
  readonly output: string
}

/**
 * Runs a command to its end and returns its exit status and its output (stdout, then stderr).
 * `FORCE_COLOR` is dropped so the output is plain text, and a command that doesn't end within
 * `timeoutMs` is killed (status `null`).
 * @internal
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv },
): CommandResult {
  const { FORCE_COLOR: _color, ...inherited } = options.env ?? process.env
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: { ...inherited, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
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
