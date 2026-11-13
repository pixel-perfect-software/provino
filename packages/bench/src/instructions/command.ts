// `provino-bench instructions` (T12.13, with the guards of T2.12, T5.14 and T3.12): every leg's
// instruction count under cachegrind, compared with a baseline record (`main`'s), and each leg's
// wall time as a `local` signal, all written to one BenchRecord. The order: build, write the
// inputs, count (each leg `--runs` times, interleaved), plant a regression if asked, time each leg
// natively (`--wall-runs` times, interleaved), T2.12's loader signals, then the record is saved and
// the summary printed (persistRecord's order).
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRunEnvironment, runProcess } from '@provino/harness'
import type { BenchRecord, BenchResult, RunRef } from '@provino/types'
import { readRunRef } from '../environment.ts'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import {
  E2E_MIN_SPEEDUP,
  type E2eResult,
  type IsolationResult,
  MAX_REGISTRY_OVERHEAD_MS,
  measureE2e,
  measureIsolation,
} from '../loader/e2e.ts'
import { FIXTURE_FILES } from '../loader/fixture.ts'
import { persistRecord, prepareOutput } from '../output.ts'
import { buildRecord, defaultOutPath } from '../report.ts'
import { median, wallStats } from '../stats.ts'
import { DEFAULT_PATHS, PACKAGE_DIR } from '../suites.ts'
import {
  anyRegressed,
  assertBaselineCovers,
  assertComparable,
  assertSameCounting,
  benchIdOf,
  compareLeg,
  comparisonLines,
  countingRunners,
  countsOf,
  type LegComparison,
  millions,
  signedPercent,
  unjudgedLegs,
} from './compare.ts'
import { LEGS, type Leg, legOf } from './legs.ts'
import { assertEmptiable, prepareWork } from './prepare.ts'
import { COUNTED_WITH, runCounted, runPlain, V8_FLAGS, valgrindVersion } from './run.ts'
import { sortedFiles, WORK_PATHS, type WorkloadResult } from './workloads.ts'

/**
 * What the command line asks for.
 * @public
 */
export interface InstructionsCommand {
  readonly command: 'instructions'
  readonly legs: readonly Leg[]
  /** A BenchRecord from an earlier run (`main`'s) to compare with. */
  readonly baseline: string | undefined
  /** Where the record goes; default `.results/<time>-instructions-node<major>-<sha7>.json`. */
  readonly out: string | undefined
  /** Cachegrind runs per leg; the count is their median. */
  readonly runs: number
  /** Plain runs per leg for the wall signal. */
  readonly wallRuns: number
  /** `false` with `--no-cachegrind`: wall signals only (any OS). */
  readonly cachegrind: boolean
  /** `--plant`: show the guard flags a real +2% rise and not a +1% one (needs cachegrind). */
  readonly plant: boolean
  /** `false` with `--no-signals`: skip T2.12's e2e-against-Jest and isolation signals. */
  readonly signals: boolean
  /** `false` with `--no-build`: the packages are already built. */
  readonly build: boolean
  /** The commit, for a tree with no `.git` (a `git archive` in a container). */
  readonly sha: string | undefined
  readonly workDir: string
  /** `--summary-file`: also append the summary there (a CI job summary). */
  readonly summaryFile: string | undefined
}

/**
 * The default work directory, inside the bench package so the inputs resolve its `node_modules`.
 * @public
 */
export const DEFAULT_WORK_DIR: string = join(PACKAGE_DIR, '.instructions')

/** The repository root, where `pnpm build` runs. */
const REPO_ROOT = DEFAULT_PATHS.repoRoot

/** The plant's target rises, in percent: one over the +1.5% line, one under it. */
const PLANT_OVER = 2
const PLANT_UNDER = 1
/** Iterations of the planted loop for the calibration run. */
const PLANT_CALIBRATION = 2_000_000

interface Io {
  out(text: string): void
  err(text: string): void
}

/** One leg's measurements. */
interface LegRuns {
  readonly leg: Leg
  readonly counts: number[]
  readonly wall: WorkloadResult[]
}

/** The planted check's outcome. */
interface PlantOutcome {
  readonly leg: Leg
  readonly perIteration: number
  readonly over: LegComparison & { readonly iterations: number }
  readonly under: LegComparison & { readonly iterations: number }
  readonly ok: boolean
}

function refFor(command: InstructionsCommand): RunRef {
  if (command.sha === undefined) return readRunRef()
  // A `git archive` of the commit: the tree is exactly it.
  return { sha: command.sha, date: new Date().toISOString(), dirty: false }
}

async function readBaseline(path: string): Promise<BenchRecord> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (cause) {
    throw new BenchError(
      'BENCH_BASELINE_INVALID',
      `${path} can't be read as JSON: ${errorMessage(cause)}`,
      { cause },
    )
  }
  const record = Object(parsed)
  if (
    Reflect.get(record, 'schemaVersion') !== 1 ||
    !Array.isArray(Reflect.get(record, 'results')) ||
    typeof Reflect.get(Object(Reflect.get(record, 'machine')), 'node') !== 'string'
  ) {
    throw new BenchError('BENCH_BASELINE_INVALID', `${path} is not a BenchRecord`)
  }
  return parsed as BenchRecord
}

function legFailure(leg: Leg, sample: WorkloadResult, how: string): BenchError {
  return new BenchError(
    'BENCH_LEG_FAILED',
    `${leg.id} (${how}) did its work wrong: ${sample.detail}`,
  )
}

/** Counts every leg `runs` times, interleaved. */
async function countLegs(command: InstructionsCommand, io: Io): Promise<Map<string, number[]>> {
  const counts = new Map<string, number[]>(command.legs.map((leg) => [leg.id, []]))
  for (let run = 1; run <= command.runs; run++) {
    for (const leg of command.legs) {
      const { instructions, sample } = await runCounted(leg.id, command.workDir, PACKAGE_DIR)
      if (!sample.ok) throw legFailure(leg, sample, 'cachegrind')
      counts.get(leg.id)?.push(instructions)
      io.err(`[local] cachegrind ${leg.id} ${run}/${command.runs}: ${millions(instructions)} Ir`)
    }
  }
  return counts
}

/**
 * The planted regression on the first suite leg: count it with a calibration loop to learn one
 * iteration's cost, then with loops sized to add 2% and 1%, and compare each with the plain count
 * at the leg's line. The guard works when the 2% run is flagged and the 1% run is not.
 */
async function plantRegression(
  command: InstructionsCommand,
  leg: Leg,
  base: number,
  io: Io,
): Promise<PlantOutcome> {
  const counted = async (iterations: number): Promise<number> => {
    const { instructions, sample } = await runCounted(
      leg.id,
      command.workDir,
      PACKAGE_DIR,
      iterations,
    )
    if (!sample.ok) throw legFailure(leg, sample, 'cachegrind, planted')
    io.err(`[local] cachegrind ${leg.id} planted ${iterations}: ${millions(instructions)} Ir`)
    return instructions
  }
  const calibrated = await counted(PLANT_CALIBRATION)
  const perIteration = (calibrated - base) / PLANT_CALIBRATION
  if (!(perIteration > 0)) {
    throw new BenchError(
      'BENCH_LEG_FAILED',
      `the planted loop added no instructions (${calibrated} against ${base})`,
    )
  }
  const sized = (percent: number): number => Math.round((base * percent) / 100 / perIteration)
  const overIterations = sized(PLANT_OVER)
  const underIterations = sized(PLANT_UNDER)
  const over = {
    ...compareLeg(leg, await counted(overIterations), base),
    iterations: overIterations,
  }
  const under = {
    ...compareLeg(leg, await counted(underIterations), base),
    iterations: underIterations,
  }
  return {
    leg,
    perIteration,
    over,
    under,
    ok: over.status === 'regressed' && under.status === 'within',
  }
}

/** Times every leg `wallRuns` times natively, interleaved. */
async function timeLegs(
  command: InstructionsCommand,
  io: Io,
): Promise<Map<string, WorkloadResult[]>> {
  const wall = new Map<string, WorkloadResult[]>(command.legs.map((leg) => [leg.id, []]))
  for (let run = 1; run <= command.wallRuns; run++) {
    for (const leg of command.legs) {
      const sample = await runPlain(leg.id, command.workDir, PACKAGE_DIR)
      wall.get(leg.id)?.push(sample)
      io.err(
        `[local] ${leg.id} ${run}/${command.wallRuns}: ${sample.ms.toFixed(1)} ms${sample.ok ? '' : ` FAILED: ${sample.detail}`}`,
      )
    }
  }
  return wall
}

function resultFor(runs: LegRuns, provinoVersion: string): BenchResult {
  const { leg } = runs
  const neutral = leg.id === 'transform' || leg.id === 'resolve' || leg.id === 'warm'
  const isolated = leg.task === 'T12.13' || leg.id === 'loader-e2e'
  const counted = runs.counts.length > 0
  return {
    benchId: benchIdOf(leg),
    subject: {
      runner: neutral ? 'provino' : 'provino:jest',
      version: provinoVersion,
      isolation: isolated ? 'registry' : 'runner-default',
      command: `pnpm provino-bench instructions --legs ${leg.id}`,
    },
    cache: leg.id === 'warm' ? 'warm' : 'cold',
    wall: wallStats(runs.wall.map((sample) => sample.ms)),
    ...(counted ? { instructions: Math.round(median(runs.counts)) } : {}),
    ok: runs.wall.every((sample) => sample.ok),
  }
}

async function provinoVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(REPO_ROOT, 'packages', 'provino', 'package.json'), 'utf8'),
  )
  const version: unknown = Reflect.get(Object(manifest), 'version')
  return typeof version === 'string' ? version : 'unknown'
}

function spreadPercent(counts: readonly number[]): string {
  if (counts.length < 2) return ''
  const low = Math.min(...counts)
  const high = Math.max(...counts)
  return `, spread ${(((high - low) / low) * 100).toFixed(3)}% over ${counts.length} runs`
}

function wallLines(runs: readonly LegRuns[], wallRuns: number): string[] {
  const lines = [
    `wall time (local signals, no valgrind, plain V8, median of ${wallRuns} interleaved runs; each a fresh process, the work alone timed, no warm-up)`,
  ]
  for (const { leg, wall } of runs) {
    const ms = median(wall.map((sample) => sample.ms))
    const units = wall[0]?.units ?? 0
    const perMs = units === 0 ? 0 : ms / units
    const per =
      units === 0
        ? ''
        : `  ${perMs >= 1 ? `${perMs.toFixed(2)} ms` : `${(perMs * 1000).toFixed(1)} µs`} per ${leg.unit}`
    lines.push(`  ${leg.id.padEnd(14)} ${ms.toFixed(1).padStart(9)} ms${per}`)
  }
  return lines
}

function signalLines(e2e: E2eResult | undefined, isolation: IsolationResult | undefined): string[] {
  if (e2e === undefined || isolation === undefined) return []
  const meets = (yes: boolean): string => (yes ? 'yes' : 'NO')
  return [
    `T2.12 (local signals, not gates): Jest ${e2e.jestVersion} + @swc/jest against Provino's loader, Spike A's ${FIXTURE_FILES} files`,
    `  per-file speedup over Jest ${e2e.speedup.toFixed(1)}x (provino ${e2e.oursPerFileMs.toFixed(2)} ms, jest ${e2e.jestPerFileMs.toFixed(2)} ms per file); ≥${E2E_MIN_SPEEDUP}x: ${meets(e2e.speedup >= E2E_MIN_SPEEDUP)}`,
    `  registry overhead ${isolation.overheadMsPerFile.toFixed(2)} ms/file (none ${isolation.noneMs.toFixed(0)} ms, registry ${isolation.registryMs.toFixed(0)} ms); ≤${MAX_REGISTRY_OVERHEAD_MS} ms: ${meets(isolation.overheadMsPerFile <= MAX_REGISTRY_OVERHEAD_MS)}`,
  ]
}

function plantLines(plant: PlantOutcome | undefined): string[] {
  if (plant === undefined) return []
  const line = (target: number, outcome: PlantOutcome['over']): string =>
    `  planted +${target}% (${outcome.iterations} iterations): ${outcome.deltaPercent === undefined ? '—' : signedPercent(outcome.deltaPercent, plant.leg.thresholdPercent)} → ${outcome.status === 'regressed' ? 'REGRESSED (flagged)' : outcome.status}`
  return [
    `planted regression on ${plant.leg.id} (flag at +${plant.leg.thresholdPercent}%; ${plant.perIteration.toFixed(1)} Ir per iteration, from a ${PLANT_CALIBRATION}-iteration run):`,
    line(PLANT_OVER, plant.over),
    line(PLANT_UNDER, plant.under),
    plant.ok
      ? '  the guard flags the +2% plant and passes the +1% one'
      : 'FAIL the planted check: the +2% plant must be flagged and the +1% one must not',
  ]
}

/**
 * Runs `provino-bench instructions` and returns its exit code: 0 when no leg regressed (and the
 * plant, when asked, behaved), 1 when one did or a leg failed.
 * @public
 */
export async function instructionsCommand(command: InstructionsCommand, io: Io): Promise<number> {
  const ref = refFor(command)
  const node = process.version
  const out = command.out ?? defaultOutPath(ref, `instructions-node${node.slice(1).split('.')[0]}`)
  await prepareOutput(out)
  // Before the build: a work directory that must not be emptied is found at once, not after it.
  await assertEmptiable(command.workDir)
  const baseline = command.baseline === undefined ? undefined : await readBaseline(command.baseline)
  if (baseline !== undefined) {
    assertComparable(baseline, { node, arch: process.arch, os: process.platform })
  }
  const valgrind = command.cachegrind ? valgrindVersion() : undefined
  // A baseline that holds no count for any leg this run measures (a record made with
  // --no-cachegrind or other --legs) would pass every leg as "no baseline", comparing nothing.
  if (baseline !== undefined && valgrind !== undefined) {
    assertBaselineCovers(baseline, command.legs)
    // Counts made with other V8 flags or valgrind options are different work, not a regression.
    assertSameCounting(baseline, COUNTED_WITH)
  }
  if (command.plant && valgrind === undefined) {
    throw new BenchError('BENCH_USAGE', '--plant needs cachegrind; drop --no-cachegrind')
  }
  if (command.build) {
    io.err('[local] pnpm build')
    const built = await runProcess('pnpm', ['build'], {
      cwd: REPO_ROOT,
      env: process.env,
      timeoutMs: 15 * 60_000,
    })
    if (built.exitCode !== 0) {
      throw new BenchError(
        'BENCH_EXEC_FAILED',
        `pnpm build exited ${built.exitCode}:\n${built.output}`,
      )
    }
  }
  await prepareWork(command.workDir)
  const filled = await runPlain('warm-fill', command.workDir, PACKAGE_DIR)
  if (!filled.ok) throw new BenchError('BENCH_LEG_FAILED', `warm-fill: ${filled.detail}`)

  const counts = valgrind === undefined ? new Map<string, number[]>() : await countLegs(command, io)
  const plantLeg = command.legs.find((leg) => leg.task === 'T12.13')
  let plant: PlantOutcome | undefined
  if (command.plant && plantLeg !== undefined) {
    plant = await plantRegression(command, plantLeg, median(counts.get(plantLeg.id) ?? []), io)
  }
  const wall = await timeLegs(command, io)
  let e2e: E2eResult | undefined
  let isolation: IsolationResult | undefined
  if (command.signals) {
    io.err('[local] T2.12 signals: bench:loader e2e and isolation')
    const fixture = join(command.workDir, WORK_PATHS.loaderFixture)
    isolation = await measureIsolation(fixture, sortedFiles(join(fixture, 'tests'), '.test.ts'))
    e2e = await measureE2e(fixture)
  }

  const runs: LegRuns[] = command.legs.map((leg) => ({
    leg,
    counts: counts.get(leg.id) ?? [],
    wall: wall.get(leg.id) ?? [],
  }))
  const version = await provinoVersion()
  const record = buildRecord({
    label: 'local',
    ref,
    environment: readRunEnvironment(
      valgrind === undefined ? {} : countingRunners(valgrind, COUNTED_WITH),
    ),
    machineId: `local-${process.platform}-${process.arch}`,
    results: runs.map((legRuns) => resultFor(legRuns, version)),
  })
  const baselineCounts = baseline === undefined ? new Map<string, number>() : countsOf(baseline)
  const comparisons = runs.map(({ leg, counts: legCounts }) =>
    compareLeg(
      leg,
      legCounts.length === 0 ? undefined : Math.round(median(legCounts)),
      baselineCounts.get(leg.id),
    ),
  )
  const failedLegs = runs.filter(({ wall: samples }) => samples.some((sample) => !sample.ok))
  const regressed = anyRegressed(comparisons)
  return persistRecord(record, out, io, async () => {
    const lines = [
      `instructions (local, Node ${node}, ${process.platform} ${process.arch}, ${valgrind === undefined ? 'no cachegrind (--no-cachegrind): wall signals only' : `valgrind ${valgrind} cachegrind --cache-sim=no, V8 ${V8_FLAGS.join(' ')}, ${command.runs} run${command.runs === 1 ? '' : 's'} per leg`}; commit ${ref.sha.slice(0, 7)}${ref.dirty ? ' (dirty)' : ''})`,
      baseline === undefined
        ? 'baseline: none (pass --baseline <record> from main to compare)'
        : `baseline: ${command.baseline} (commit ${baseline.ref.sha.slice(0, 7)}, ${baseline.ref.date})`,
      '',
      ...comparisonLines(comparisons),
      ...runs
        .filter(({ counts: legCounts }) => legCounts.length > 1)
        .map(({ leg, counts: legCounts }) => `  ${leg.id}${spreadPercent(legCounts)}`),
      '',
      ...plantLines(plant),
      ...(plant === undefined ? [] : ['']),
      ...wallLines(runs, command.wallRuns),
      ...signalLines(e2e, isolation),
      ...failedLegs.map(({ leg }) => `FAIL ${leg.id}: a run did its work wrong`),
      regressed
        ? `RESULT: ${comparisons.filter((comparison) => comparison.status === 'regressed').length} leg(s) regressed`
        : `RESULT: no leg regressed${resultNote(baseline !== undefined && valgrind !== undefined, unjudgedLegs(comparisons))}`,
    ]
    const text = lines.join('\n')
    io.out(text)
    if (command.summaryFile !== undefined) await appendFile(command.summaryFile, `${text}\n`)
    return regressed || failedLegs.length > 0 || plant?.ok === false ? 1 : 0
  })
}

/** What the passing result line adds: that nothing was compared, or which legs went unjudged. */
function resultNote(compared: boolean, unjudged: readonly string[]): string {
  if (!compared) return ' (nothing was compared)'
  return unjudged.length === 0 ? '' : ` (no baseline count for ${unjudged.join(', ')}: not judged)`
}

/**
 * Parses the leg list of `--legs a,b`; every leg when absent. A `BENCH_USAGE` error names an unknown
 * one.
 * @public
 */
export function parseLegs(value: string | undefined): readonly Leg[] {
  if (value === undefined) return LEGS
  const legs: Leg[] = []
  for (const id of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const leg = legOf(id)
    if (leg === undefined) {
      throw new BenchError(
        'BENCH_USAGE',
        `--legs: unknown leg ${JSON.stringify(id)}; the legs are ${LEGS.map((each) => each.id).join(', ')}`,
      )
    }
    if (!legs.includes(leg)) legs.push(leg)
  }
  if (legs.length === 0) throw new BenchError('BENCH_USAGE', '--legs names no leg')
  return legs
}
