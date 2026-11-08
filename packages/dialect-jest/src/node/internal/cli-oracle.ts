// The CLI oracle for T11.7's tests: real `jest-cli` 30.5.2's `buildArgv`, run in one child process
// for a whole corpus of command lines (`cli-oracle-child.ts`). A case comes back as the argv Jest
// built, or as how it failed (yargs prints its message and exits 1; jest-validate throws).
import { spawnSync } from 'node:child_process'
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

/** Runs real `buildArgv` on every command line, in one child process. */
export function runCliOracle(cases: readonly (readonly string[])[]): readonly OracleOutcome[] {
  return JSON.parse(runChild(cases)) as OracleOutcome[]
}

/** jest-cli's own `yargsOptions` table, in `encodeForCompare` form. */
export function oracleOptions(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return JSON.parse(runChild([['--print-options']])) as Record<string, Record<string, unknown>>
}

/** Text without ANSI colours. */
export function plain(text: string): string {
  return stripVTControlCharacters(text)
}
