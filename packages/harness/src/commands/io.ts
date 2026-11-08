import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'

/**
 * Where a command writes: `out` for its result (JSON, or nothing), `err` for what a person reads.
 * The CLI passes the process's streams; tests pass collectors.
 * @internal
 */
export interface CommandIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

/**
 * The process's own streams.
 * @internal
 */
export const processIo: CommandIo = {
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
}

/**
 * A command's input file, or `HARNESS_USAGE` naming what it is and why it can't be read.
 * @internal
 */
export async function readText(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    throw new HarnessError(
      'HARNESS_USAGE',
      `can't read the ${what} ${file}: ${errorMessage(cause)}`,
      {
        path: file,
        cause,
      },
    )
  }
}

/**
 * A harness error as a command prints it: its code, then its message.
 * @internal
 */
export function failureText(error: HarnessError): string {
  return `${error.code}: ${error.message}`
}

/**
 * Writes a value as 2-space JSON with a trailing newline, creating the file's directory.
 * @internal
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}
