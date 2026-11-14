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

/** Real Jest 30.5.2's bin, from the Jest the harness installs: the oracle. */
export const JEST: string = createRequire(
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

/**
 * The environment of a live Jest run: this process's, with colour off, as the harness's recorder
 * runs it (`runnerEnv`: `NO_COLOR=1`, no `FORCE_COLOR`), so every golden and every live run is
 * read under the same conditions. Provino prints no colour (`--colors` is read but not applied).
 * Jest does: `@babel/code-frame`, behind the code frame of an error or an open handle, highlights it
 * whenever picocolors says colours are supported, which a set `CI` is enough for (GitHub's
 * runners set it), a TTY or `FORCE_COLOR` too, whatever the stream is.
 */
export function noColorEnv(): NodeJS.ProcessEnv {
  const { FORCE_COLOR: _force, ...rest } = process.env
  return { ...rest, NO_COLOR: '1' }
}

/** Runs real Jest with `args` in `cwd`: its exit code and its stderr, where it prints its report. */
export function runJest(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, ...args], {
      cwd,
      env: noColorEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
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
  await runJest(cwd, [
    '--no-cache',
    '--ci',
    '-c',
    'jest.live.json',
    '--json',
    `--outputFile=${out}`,
  ])
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
  // A memory limit asks for workers, as the recorded runs of the fixtures that need one had it:
  // a single file would otherwise run in band, in this test process (Jest's `shouldRunInBand`).
  const code = await runJestCommand(
    ['--no-cache', '--ci', '-c', 'jest.config.json', '--workerIdleMemoryLimit=8000000000'],
    {
      stdout: new Sink(),
      stderr,
      cwd,
      reporters: [['normalized-json', { outputFile: out }]],
    },
  )
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
