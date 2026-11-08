// `provino-harness convert`: one runner's raw output, written as a NormalizedRun file for `diff`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun } from '@provino/types'
import { convertJest } from '../convert-jest.ts'
import { convertProvino } from '../convert-provino.ts'
import { convertVitest } from '../convert-vitest.ts'
import { readRunEnvironment } from '../environment.ts'
import { HarnessError } from '../errors.ts'
import type { ConvertCommand } from '../internal/cli-args.ts'
import { errorMessage } from '../internal/guards.ts'
import { parseJestJson, parseVitestJson } from '../parse-results.ts'
import { resolveRunnerPackage } from '../runner-package.ts'
import { parseSidecar } from '../sidecar.ts'
import type { CommandIo } from './io.ts'

async function readText(file: string, what: string): Promise<string> {
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

/** `--runner-version`, else the version of the runner installed for the root. */
function versionOf(command: ConvertCommand, root: string): string {
  if (command.runnerVersion !== undefined) return command.runnerVersion
  try {
    return resolveRunnerPackage(command.runner, root).version
  } catch (cause) {
    throw new HarnessError(
      'HARNESS_USAGE',
      `${command.runner} is not installed for ${root}: pass --runner-version`,
      { cause },
    )
  }
}

async function convert(command: ConvertCommand): Promise<NormalizedRun> {
  const root = path.resolve(command.root)
  const text = await readText(command.input, 'input')
  if (command.runner === 'provino') {
    return convertProvino(text, { rootDir: root, suite: command.suite }, command.input)
  }
  const runnerVersion = versionOf(command, root)
  const options = {
    rootDir: root,
    suite: command.suite,
    runnerVersion,
    env: readRunEnvironment({ [command.runner]: runnerVersion }),
    ...(command.sidecar === undefined
      ? {}
      : { console: parseSidecar(await readText(command.sidecar, 'sidecar'), command.sidecar) }),
  }
  return command.runner === 'jest'
    ? convertJest(parseJestJson(text, command.input), options)
    : convertVitest(parseVitestJson(text, command.input), options)
}

/**
 * Runs `convert`: the runner's JSON (and, for Jest and Vitest, the sidecar's console file) to a
 * `NormalizedRun`, written to `--out` as 2-space JSON. The run's `env` is this machine's, since a
 * raw file doesn't say where it ran, and it hashes no snapshot files (`runSubject` does, right
 * after its run). Exit 0 when the file is written, 2 when an input can't be read or converted.
 * @internal
 */
export async function convertCommand(command: ConvertCommand, io: CommandIo): Promise<number> {
  let run: NormalizedRun
  try {
    run = await convert(command)
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    io.err(`${error.code}: ${error.message}\n`)
    return 2
  }
  await mkdir(path.dirname(path.resolve(command.out)), { recursive: true })
  await writeFile(command.out, `${JSON.stringify(run, null, 2)}\n`)
  io.err(`wrote ${command.out}\n`)
  return 0
}
