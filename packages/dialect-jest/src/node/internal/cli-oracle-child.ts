// The child process of the CLI oracle (T11.7 tests): reads a JSON array of argv arrays from stdin,
// runs real `jest-cli` 30.5.2's `buildArgv` on each, and writes one JSON result per case to
// stdout. Real yargs prints its message to stderr and calls `process.exit(1)` on a bad command
// line, so `process.exit`, `process.stderr.write` and the console are stubbed here and what they
// were given is returned. One child serves a whole corpus (spawning hundreds would be slow).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { encodeForCompare } from './cli-encode.ts'

const require = createRequire(import.meta.url)
const { buildArgv, yargsOptions } = require('jest-cli') as {
  buildArgv(args: readonly string[]): Promise<Record<string, unknown>>
  yargsOptions: Record<string, unknown>
}

/** How long one command line may take; a hung case is reported, not waited for. */
const CASE_TIMEOUT_MS = 20_000

class ExitSignal extends Error {
  readonly code: number
  constructor(code: number | undefined) {
    super(`exit ${code}`)
    this.code = code ?? 0
  }
}

/** What one `buildArgv` call did. */
interface Outcome {
  argv?: unknown
  threw?: string
  exit?: number
  stderr: string
  stdout: string
  warn: string
}

async function runOne(args: readonly string[]): Promise<Outcome> {
  const outcome: Outcome = { stderr: '', stdout: '', warn: '' }
  const realExit = process.exit
  const realStderr = process.stderr.write
  const realStdout = process.stdout.write
  const realConsole = { error: console.error, log: console.log, warn: console.warn }
  const text = (parts: readonly unknown[]): string => `${parts.map(String).join(' ')}\n`
  console.error = (...parts: unknown[]) => {
    outcome.stderr += text(parts)
  }
  console.log = (...parts: unknown[]) => {
    outcome.stdout += text(parts)
  }
  console.warn = (...parts: unknown[]) => {
    outcome.warn += text(parts)
  }
  process.stderr.write = ((chunk: unknown) => {
    outcome.stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  process.stdout.write = ((chunk: unknown) => {
    outcome.stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.exit = ((code?: number) => {
    throw new ExitSignal(code)
  }) as typeof process.exit
  let watchdog: NodeJS.Timeout | undefined
  try {
    // A case that never settles must name itself, not stall the whole corpus until the parent's
    // timeout: the test then fails on that line with this text.
    const argv = await Promise.race([
      buildArgv(args),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`the oracle did not answer within ${CASE_TIMEOUT_MS} ms`)),
          CASE_TIMEOUT_MS,
        )
      }),
    ])
    const { $0: _program, ...rest } = argv
    outcome.argv = encodeForCompare(rest)
  } catch (error) {
    if (error instanceof ExitSignal) outcome.exit = error.code
    else outcome.threw = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(watchdog)
    process.exit = realExit
    process.stderr.write = realStderr
    process.stdout.write = realStdout
    console.error = realConsole.error
    console.log = realConsole.log
    console.warn = realConsole.warn
  }
  return outcome
}

const cases = JSON.parse(readFileSync(0, 'utf8')) as string[][]
if (cases[0]?.[0] === '--print-options') {
  process.stdout.write(JSON.stringify(encodeForCompare(yargsOptions)))
} else {
  const results: Outcome[] = []
  for (const args of cases) results.push(await runOne(args))
  process.stdout.write(JSON.stringify(results))
}
