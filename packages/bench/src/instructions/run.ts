// Running the child: plainly (the wall signal) and under cachegrind (the instruction count). The
// child runs Provino's built packages, so the parent builds first (`pnpm build`, cached by Turbo).
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@provino/harness'
import { BenchError } from '../errors.ts'
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { readCachegrindDir, totalInstructions } from './cachegrind.ts'
import type { WorkloadResult } from './workloads.ts'

/**
 * V8's flags under cachegrind (Track 12 F7: 0.05% spread over 3 runs with them, 0.6% without):
 * one thread, no optimising tier, and V8's deterministic mode.
 * @public
 */
export const V8_FLAGS: readonly string[] = ['--single-threaded', '--no-opt', '--predictable']

/** The child entry. */
const CHILD: string = fileURLToPath(new URL('child.ts', import.meta.url))

/**
 * What Node needs to run the child's TypeScript: nothing from 22.18 (stripping is on by default),
 * `--experimental-strip-types` below it (the 22.15 floor), since the child's environment carries no
 * `NODE_OPTIONS`.
 * @public
 */
export function stripTypesArgs(version: string = process.version): readonly string[] {
  const [major = 0, minor = 0] = version.slice(1).split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 18) ? [] : ['--experimental-strip-types']
}

/** The longest one cachegrind run may take (about 55× the plain run, Track 12 F7). */
const CACHEGRIND_TIMEOUT_MS = 60 * 60_000
const PLAIN_TIMEOUT_MS = 10 * 60_000

/**
 * The child's environment: the same few variables every run, so a count never moves with the
 * caller's shell. No compile cache (a second run would read the first's), no colour, UTC.
 * @public
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const fixed: Record<string, string> = {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? '',
    NODE_DISABLE_COMPILE_CACHE: '1',
    NO_COLOR: '1',
    TZ: 'UTC',
    LANG: 'C',
  }
  if (env.TMPDIR !== undefined) fixed.TMPDIR = env.TMPDIR
  return fixed
}

/**
 * The child's `PROVINO_SAMPLE` line, or `undefined` when it printed none that parses.
 * @public
 */
export function readWorkload(output: string): WorkloadResult | undefined {
  for (const line of output.split('\n')) {
    if (!line.startsWith(SAMPLE_PREFIX)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(SAMPLE_PREFIX.length))
    } catch {
      continue
    }
    const value = Object(parsed)
    const ok: unknown = Reflect.get(value, 'ok')
    const ms: unknown = Reflect.get(value, 'ms')
    const units: unknown = Reflect.get(value, 'units')
    const detail: unknown = Reflect.get(value, 'detail')
    if (
      typeof ok === 'boolean' &&
      typeof ms === 'number' &&
      Number.isFinite(ms) &&
      typeof units === 'number' &&
      typeof detail === 'string'
    ) {
      return { ok, ms, units, detail }
    }
  }
  return undefined
}

function failed(what: string, result: { exitCode: number | null; output: string }): BenchError {
  return new BenchError(
    'BENCH_LEG_FAILED',
    `${what} exited ${result.exitCode ?? 'on a signal'}:\n${result.output.trim()}`,
  )
}

/**
 * Test seams for running the child: Node arguments before it (the tests run Provino from source
 * with `--conditions=provino-source`; the command runs the built packages), and the valgrind
 * command and its first arguments (a stand-in in the tests).
 * @public
 */
export interface ChildSeams {
  readonly nodeArgs?: readonly string[]
  readonly valgrind?: readonly string[]
}

/**
 * Runs the child plainly once: `leg` (or `warm-fill`) on `work`. Throws `BENCH_LEG_FAILED` when it
 * printed no sample; a sample whose work was wrong comes back with `ok: false`.
 * @public
 */
export async function runPlain(
  leg: string,
  work: string,
  cwd: string,
  seams: ChildSeams = {},
): Promise<WorkloadResult> {
  const args = [...stripTypesArgs(), ...(seams.nodeArgs ?? []), CHILD, leg, work]
  const result = await runProcess(process.execPath, args, {
    cwd,
    env: childEnv(),
    timeoutMs: PLAIN_TIMEOUT_MS,
  })
  const sample = readWorkload(result.output)
  if (sample === undefined) throw failed(`${leg} (plain)`, result)
  return sample
}

/**
 * The valgrind version (`valgrind-3.22.0` → `3.22.0`). Throws `BENCH_CACHEGRIND_UNAVAILABLE` when
 * there is none: cachegrind runs on Linux only.
 * @public
 */
export function valgrindVersion(): string {
  try {
    return execFileSync('valgrind', ['--version'], { encoding: 'utf8' })
      .trim()
      .replace(/^valgrind-/, '')
  } catch (cause) {
    throw new BenchError(
      'BENCH_CACHEGRIND_UNAVAILABLE',
      `valgrind is not installed here (${process.platform}); instruction counts need Linux. Run the command in a container (see the Commands table in CLAUDE.md), or pass --no-cachegrind for the wall signals alone`,
      { cause },
    )
  }
}

/**
 * Runs the child once under cachegrind and returns the instruction count of every process it ran
 * (`--trace-children=yes`; the legs run one inline worker, so it is one process) with the child's
 * sample. `plant` adds that many iterations of the planted loop. Throws `BENCH_LEG_FAILED` when the
 * child printed no sample or valgrind failed.
 * @public
 */
export async function runCounted(
  leg: string,
  work: string,
  cwd: string,
  plant = 0,
  seams: ChildSeams = {},
): Promise<{ readonly instructions: number; readonly sample: WorkloadResult }> {
  const dir = await mkdtemp(join(tmpdir(), `provino-cachegrind-${leg}-`))
  const [valgrind = 'valgrind', ...valgrindArgs] = seams.valgrind ?? ['valgrind']
  try {
    const result = await runProcess(
      valgrind,
      [
        ...valgrindArgs,
        '--tool=cachegrind',
        '--cache-sim=no',
        '--trace-children=yes',
        `--cachegrind-out-file=${join(dir, 'cachegrind.out.%p')}`,
        `--log-file=${join(dir, 'valgrind.%p.log')}`,
        process.execPath,
        ...V8_FLAGS,
        ...stripTypesArgs(),
        ...(seams.nodeArgs ?? []),
        CHILD,
        leg,
        work,
        String(plant),
      ],
      { cwd, env: childEnv(), timeoutMs: CACHEGRIND_TIMEOUT_MS },
    )
    const sample = readWorkload(result.output)
    if (sample === undefined || result.exitCode !== 0) {
      const logs = await readCachegrindLogs(dir)
      throw failed(`${leg} (cachegrind)`, {
        exitCode: result.exitCode,
        output: `${result.output}\n${logs}`,
      })
    }
    return { instructions: totalInstructions(await readCachegrindDir(dir)), sample }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readCachegrindLogs(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => name.startsWith('valgrind.'))
  const texts = await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))
  return texts.join('\n').slice(-4000)
}
