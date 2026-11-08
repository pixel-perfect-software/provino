// `provino-bench list-tests <dir>` (U2): the test files Jest's `--listTests` lists in a project
// directory, against the ones `provino jest --listTests` lists. The R6 repos are run through this
// once B16's installer has put them on disk; the synthetic trees are `provino`'s own
// `list-tests.test.ts`, against goldens. Provino runs only as the `provino` bin (DECISIONS S4).
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveRunnerPackage, spawnInGroup } from '@provino/harness'
import { BenchError } from './errors.ts'

/** What each runner listed for one directory. */
export interface TestLists {
  readonly jest: readonly string[]
  readonly provino: readonly string[]
}

/**
 * How two lists compare: as sets, because Jest orders its list by file sizes and cached timings.
 * @public
 */
export interface ListComparison {
  readonly equal: boolean
  readonly common: number
  readonly onlyJest: readonly string[]
  readonly onlyProvino: readonly string[]
}

/**
 * Compares two lists as sets.
 * @public
 */
export function compareLists(jest: readonly string[], provino: readonly string[]): ListComparison {
  const inJest = new Set(jest)
  const inProvino = new Set(provino)
  const onlyJest = [...inJest].filter((path) => !inProvino.has(path)).sort()
  const onlyProvino = [...inProvino].filter((path) => !inJest.has(path)).sort()
  return {
    equal: onlyJest.length === 0 && onlyProvino.length === 0,
    common: inJest.size - onlyJest.length,
    onlyJest,
    onlyProvino,
  }
}

/** A runner's `--listTests --json` output as a list of paths, or the reason it is not one. */
export function parseList(runner: string, text: string): readonly string[] {
  // Jest prints the array on a line of its own; anything before it is a warning.
  const line = text
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('['))
  let parsed: unknown
  try {
    parsed = line === undefined ? undefined : JSON.parse(line)
  } catch {
    parsed = undefined
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new BenchError('BENCH_EXEC_FAILED', `${runner} printed no JSON list of test files`)
  }
  return parsed
}

/** One command's stdout, stderr and exit code, with a deadline. */
async function capture(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  const { child, exited } = spawnInGroup(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const ended = await exited
  return { stdout, stderr, code: ended.exitCode }
}

/**
 * Runs both runners' `--listTests --json` in `dir`. Jest is the project's own (`node_modules/jest`)
 * when it has one, else the one installed for the bench; Provino is the `provino` bin from source.
 * @public
 */
export async function readLists(dir: string, timeoutMs: number): Promise<TestLists> {
  const root = resolve(dir)
  const own = resolve(root, 'node_modules', 'jest', 'bin', 'jest.js')
  const jestBin = existsSync(own) ? own : resolveRunnerPackage('jest', import.meta.url).bin
  const provinoBin = resolveRunnerPackage('provino', import.meta.url).bin
  const listed = async (
    runner: string,
    command: string,
    args: readonly string[],
  ): Promise<readonly string[]> => {
    const ran = await capture(command, args, root, timeoutMs)
    if (ran.code !== 0) {
      throw new BenchError(
        'BENCH_EXEC_FAILED',
        `${runner} exited with ${String(ran.code)} listing ${root}:\n${ran.stderr.slice(-2000)}`,
      )
    }
    return parseList(runner, ran.stdout)
  }
  const jest = await listed('jest', process.execPath, [jestBin, '--listTests', '--json'])
  const provino = await listed('provino', process.execPath, [
    '--conditions=provino-source',
    provinoBin,
    'jest',
    '--listTests',
    '--json',
  ])
  return { jest, provino }
}

/**
 * The `list-tests` command: prints both counts and every difference, and returns 0 when the lists
 * are the same set, else 1.
 * @public
 */
export async function listTestsCommand(
  dir: string,
  io: { out(text: string): void; err(text: string): void },
  read: (dir: string) => Promise<TestLists> = (target) => readLists(target, 10 * 60_000),
): Promise<number> {
  const lists = await read(dir)
  const comparison = compareLists(lists.jest, lists.provino)
  io.out(`jest: ${lists.jest.length} test files, provino: ${lists.provino.length}`)
  io.out(`in both: ${comparison.common}`)
  for (const path of comparison.onlyJest) io.out(`only jest:    ${path}`)
  for (const path of comparison.onlyProvino) io.out(`only provino: ${path}`)
  io.out(comparison.equal ? 'the lists are the same set' : 'the lists differ')
  return comparison.equal ? 0 : 1
}
