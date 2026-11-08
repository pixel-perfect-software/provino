// The CLI oracle for T11.7's tests: real `jest-cli` 30.5.2's `buildArgv`, run in a few child
// processes at once for a whole corpus of command lines (`cli-oracle-child.ts`). A case comes
// back as the argv Jest built, or as how it failed (yargs prints its message and exits 1;
// jest-validate throws).
import { spawn, spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

/** What real Jest did with one command line. */
export interface OracleOutcome {
  /** The argv `buildArgv` returned (minus `$0`), in `encodeForCompare` form. */
  readonly argv?: unknown
  /** The message of an error `buildArgv` threw (jest-validate's `ValidationError`). */
  readonly threw?: string
  /** The code yargs passed to `process.exit`. */
  readonly exit?: number
  readonly stderr: string
  readonly stdout: string
  readonly warn: string
}

const CHILD = new URL('./cli-oracle-child.ts', import.meta.url)

function runChild(input: unknown): string {
  const result = spawnSync(process.execPath, [...process.execArgv, CHILD.pathname], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  })
  if (result.status !== 0) {
    throw new Error(`the CLI oracle child failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout
}

/** One child, asynchronously: it ends with its output or fails, and is killed after `timeoutMs`. */
function runChildAsync(input: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, CHILD.pathname], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      if (status === 0) resolve(stdout)
      else {
        reject(
          new Error(
            `the CLI oracle child failed (${status ?? signal}) after at most ${timeoutMs} ms: ${stderr}`,
          ),
        )
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

/**
 * Runs real `buildArgv` on every command line, split over `parts` children at once: a slow
 * machine (CI runs every package's tests together) finishes in about a part's time, and one child
 * has the whole timeout to itself. The results are in the cases' order.
 */
export async function runCliOracleParallel(
  cases: readonly (readonly string[])[],
  parts = 4,
  timeoutMs = 300_000,
): Promise<readonly OracleOutcome[]> {
  const size = Math.ceil(cases.length / parts)
  const slices: (readonly string[])[][] = []
  for (let from = 0; from < cases.length; from += size) slices.push(cases.slice(from, from + size))
  const outputs = await Promise.all(slices.map((slice) => runChildAsync(slice, timeoutMs)))
  return outputs.flatMap((output) => JSON.parse(output) as OracleOutcome[])
}

/** jest-cli's own `yargsOptions` table, in `encodeForCompare` form. */
export function oracleOptions(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return JSON.parse(runChild([['--print-options']])) as Record<string, Record<string, unknown>>
}

/** Text without ANSI colours. */
export function plain(text: string): string {
  return stripVTControlCharacters(text)
}
