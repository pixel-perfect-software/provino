// Helpers for the end-to-end tests that hold Provino to real Jest 30.5.2: the live Jest run on a
// temp tree, Provino's own run (through `runJestCommand`, with the normalized-json reporter), and
// each one's statuses as `<file>::<full name>` in Jest's words.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { viewOfNormalized } from './support.ts'

const JEST: string = createRequire(
  fileURLToPath(new URL('../../harness/package.json', import.meta.url)),
).resolve('jest/bin/jest')

/**
 * `runJestCommand`, loaded by URL: the type-test project includes this directory but not the
 * package's source, and the command has no flag for a reporter yet (T11.9).
 */
const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: {
      stdout: Writable
      stderr: Writable
      cwd: string
      reporters: readonly (readonly ['normalized-json', { outputFile: string }])[]
    },
  ): Promise<number>
}

class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** The harness's transformer, which strips types for real Jest as the recorder does. */
const TRANSFORMER = fileURLToPath(new URL('../../harness/src/jest-transform.ts', import.meta.url))

function runJest(cwd: string, out: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, '--no-cache', '--ci', '-c', 'jest.live.json', '--json', `--outputFile=${out}`],
      { cwd, stdio: 'ignore' },
    )
    child.once('error', reject)
    child.once('close', resolve)
  })
}

export type Statuses = ReadonlyMap<string, string>

/** Real Jest's live statuses by `<file>::<full name>`. */
export async function liveJest(cwd: string): Promise<Statuses> {
  const out = join(cwd, '.out-jest.json')
  const config = JSON.parse(await readFile(join(cwd, 'jest.config.json'), 'utf8')) as object
  await writeFile(
    join(cwd, 'jest.live.json'),
    JSON.stringify({ ...config, transform: { '\\.[cm]?ts$': TRANSFORMER } }),
  )
  await runJest(cwd, out)
  const report = JSON.parse(await readFile(out, 'utf8')) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
  }
  const map = new Map<string, string>()
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      map.set(`${relative(cwd, file.name)}::${test.fullName}`, test.status)
    }
  }
  return map
}

/** Provino's statuses, read from its normalized-json, in Jest's words. */
export async function provinoRun(
  cwd: string,
): Promise<{ code: number; statuses: Statuses; stderr: string }> {
  const out = join(cwd, '.out-provino.json')
  const stderr = new Sink()
  const code = await runJestCommand(['--no-cache', '--ci', '-c', 'jest.config.json'], {
    stdout: new Sink(),
    stderr,
    cwd,
    reporters: [['normalized-json', { outputFile: out }]],
  })
  const word: Readonly<Record<string, string>> = { skipped: 'pending' }
  const map = new Map<string, string>()
  for (const [file, entry] of viewOfNormalized(await readFile(out, 'utf8')).files) {
    const path = file.startsWith('/') ? relative(cwd, file) : file
    for (const [name, status] of entry.tests) {
      map.set(`${path}::${name.replaceAll(' > ', ' ')}`, word[String(status)] ?? String(status))
    }
  }
  return { code, statuses: map, stderr: stderr.text }
}

export const sorted = (map: Statuses): [string, string][] =>
  [...map].sort(([a], [b]) => (a < b ? -1 : 1))
