// The `e2e` leg of `bench:reporter` (B26 Phase 3, D145): a whole suite under the **built** bin on
// the harness's pty, `provino run --reporter provino` against `--reporter agent`, interleaved (one
// round discarded, rounds alternate which subject goes first). Two numbers per suite, both `local`:
// the wall median ratio with its bootstrap 95% CI, and the CPU the bin's own process (the
// coordinator, where every reporter runs) used, read from `process.cpuUsage()` at its `exit` by a
// preload that writes `{ pid, cpu }` to the file `PROVINO_BENCH_CPU_FILE` names. Forked workers
// inherit the preload and write their own lines, which are left out by pid: the pty child is the
// bin, and leads its session, so its pid is the session's group id.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { groupExists, spawnPty } from '@provino/harness'
import { OUTPUT_VARIABLES } from '@provino/reporters'
import { BenchError } from '../errors.ts'
import { median, ratioCi } from '../stats.ts'
import { parseSuiteName, suiteDir, writeSuite } from '../suites.ts'
import type { E2eResult } from './report.ts'

/** The two subjects, in the order a round starts with on even rounds. */
export const E2E_SUBJECTS = ['provino', 'agent'] as const
export type E2eSubject = (typeof E2E_SUBJECTS)[number]

/** The variable the probe reads for the file it appends to. */
export const CPU_FILE_VARIABLE = 'PROVINO_BENCH_CPU_FILE'

/**
 * The preload: at `exit`, one JSON line with the process's pid and its `cpuUsage()` (µs), appended
 * synchronously (an `exit` listener can't wait). Plain JavaScript, passed as a `data:` URL, so no
 * child loads a `.ts` file.
 */
export const CPU_PROBE_SOURCE: string = [
  "import { appendFileSync } from 'node:fs'",
  `const file = process.env.${CPU_FILE_VARIABLE}`,
  'if (file) {',
  "  process.once('exit', () => {",
  "    appendFileSync(file, JSON.stringify({ pid: process.pid, cpu: process.cpuUsage() }) + '\\n')",
  '  })',
  '}',
  '',
].join('\n')

/** The `NODE_OPTIONS` entry that preloads the probe. */
export function cpuProbeImport(): string {
  return `--import=data:text/javascript,${encodeURIComponent(CPU_PROBE_SOURCE)}`
}

/** The bin's arguments for one subject on a suite's Provino config. */
export function e2eArgs(subject: E2eSubject, config: string): readonly string[] {
  return ['run', '--config', config, '--reporter', subject]
}

/**
 * The CPU the process `pid` used, in ms (user plus system), from the probe's lines; `undefined` when
 * none of them is that process's. A line that is not the probe's shape is an error: the file is the
 * bench's own.
 */
export function parseCpuProbe(text: string, pid: number): number | undefined {
  let found: number | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed: unknown = JSON.parse(line)
    const linePid = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'pid') : 0
    const cpu: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'cpu') : undefined
    const user = typeof cpu === 'object' && cpu !== null ? Reflect.get(cpu, 'user') : undefined
    const system = typeof cpu === 'object' && cpu !== null ? Reflect.get(cpu, 'system') : undefined
    if (typeof linePid !== 'number' || typeof user !== 'number' || typeof system !== 'number') {
      throw new BenchError('BENCH_LEG_FAILED', `the CPU probe wrote a line it can't have: ${line}`)
    }
    if (linePid === pid) found = (user + system) / 1000
  }
  return found
}

/** The built bin, which the leg needs (`pnpm --filter provino build`). */
function builtBin(): string {
  const bin = join(
    dirname(fileURLToPath(import.meta.resolve('provino/package.json'))),
    'dist',
    'cli.js',
  )
  if (!existsSync(bin)) {
    throw new BenchError(
      'BENCH_USAGE',
      `${bin} is not built: run \`pnpm --filter provino build\` first`,
    )
  }
  return bin
}

/** An interactive terminal's environment: none of the variables that say CI, an agent or colour. */
function terminalEnv(cpuFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of OUTPUT_VARIABLES) delete env[name]
  for (const name of ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'NODE_OPTIONS']) {
    delete env[name]
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, cpuProbeImport()].filter(Boolean).join(' '),
    [CPU_FILE_VARIABLE]: cpuFile,
  }
}

/** One run: its wall time and the coordinator's CPU, both ms. */
interface E2eRun {
  readonly wallMs: number
  readonly cpuMs: number
}

async function runOnce(bin: string, cwd: string, subject: E2eSubject, work: string, n: number) {
  const cpuFile = join(work, `cpu-${subject}-${n}.jsonl`)
  const started = performance.now()
  const session = await spawnPty(
    [process.execPath, bin, ...e2eArgs(subject, 'provino.config.mjs')],
    {
      cwd,
      env: terminalEnv(cpuFile),
      deadline: AbortSignal.timeout(10 * 60_000),
    },
  )
  let exit: Awaited<typeof session.exit>
  let wallMs: number
  try {
    exit = await session.exit
    wallMs = performance.now() - started
  } finally {
    await session.kill()
  }
  // `kill()` waits until the group is gone; this is the probe that says so.
  if (groupExists(session.childPgid)) {
    throw new BenchError('BENCH_LEG_FAILED', `the run's group ${session.childPgid} is still there`)
  }
  if (exit.exitCode !== 0) {
    throw new BenchError(
      'BENCH_LEG_FAILED',
      `provino run --reporter ${subject} exited ${exit.exitCode}:\n${session.output().slice(-2000)}`,
    )
  }
  const cpuMs = parseCpuProbe(await readFile(cpuFile, 'utf8'), session.childPgid)
  if (cpuMs === undefined) {
    throw new BenchError('BENCH_LEG_FAILED', `the bin (pid ${session.childPgid}) wrote no CPU line`)
  }
  return { wallMs, cpuMs } satisfies E2eRun
}

/**
 * `e2e` on one suite: the suite written (idempotently) into the bench's `.suites/`, then `runs + 1`
 * rounds of both subjects, the first round discarded. Every number is `local`.
 */
export async function runE2eLeg(suiteName: string, runs: number): Promise<E2eResult> {
  const bin = builtBin()
  const spec = parseSuiteName(suiteName)
  await writeSuite(spec)
  const cwd = join(suiteDir(spec), 'jest')
  const work = await mkdtemp(join(tmpdir(), 'provino-bench-e2e-'))
  const kept: Record<E2eSubject, E2eRun[]> = { provino: [], agent: [] }
  try {
    for (let round = 0; round <= runs; round++) {
      const order = round % 2 === 0 ? E2E_SUBJECTS : ([...E2E_SUBJECTS].reverse() as E2eSubject[])
      for (const subject of order) {
        const result = await runOnce(bin, cwd, subject, work, round)
        if (round > 0) kept[subject].push(result) // round 0 warms the caches and is not kept
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  const wall = (subject: E2eSubject) => kept[subject].map((run) => run.wallMs)
  const cpu = (subject: E2eSubject) => kept[subject].map((run) => run.cpuMs)
  const interval = ratioCi(wall('provino'), wall('agent'))
  const provinoCpuMs = median(cpu('provino'))
  const agentCpuMs = median(cpu('agent'))
  return {
    suite: suiteName,
    runs,
    provinoMedianMs: median(wall('provino')),
    agentMedianMs: median(wall('agent')),
    ratio: interval.ratio,
    ratioLow: interval.low,
    ratioHigh: interval.high,
    provinoCpuMs,
    agentCpuMs,
    cpuOverhead: provinoCpuMs / agentCpuMs - 1,
  }
}
