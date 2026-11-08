// `pnpm bench:jest-config load [--max-cold-ms N] [--runs N]`: T11.4's bar, "the Spike B fixture
// loads in under 150 ms cold". Every run is a fresh process (a cold module cache), and the bar is
// applied twice, as gap 3 of `bundles/B14.md` says (Spike B measured 86 ms in-process and 166 ms
// wall): to the median in-process time (the reader's import, find and load, timed inside the
// process) and to the median wall time of the whole process. Every number is `local`.
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@provino/harness'
import { readSample } from '../internal/limits.ts'
import { median } from '../stats.ts'
import { SPIKE_B_KEYS, writeSpikeBFixture } from './fixture.ts'

/** The default number of cold runs. */
export const LOAD_RUNS = 10

const KEYS = ['inProcessMs', 'loadMs', 'keys'] as const

/** One cold run's numbers. */
export interface LoadSample {
  readonly inProcessMs: number
  readonly loadMs: number
  readonly wallMs: number
}

/** What `load` measured, and the bar's verdict on each median. */
export interface LoadReport {
  readonly runs: readonly LoadSample[]
  readonly medianInProcessMs: number
  readonly medianLoadMs: number
  readonly medianWallMs: number
  readonly failures: readonly string[]
}

/** The bar on the medians. */
export function loadFailures(
  medians: { readonly inProcessMs: number; readonly wallMs: number },
  maxColdMs: number | undefined,
): string[] {
  if (maxColdMs === undefined) return []
  const out: string[] = []
  // "Under 150 ms": strictly less, written `!(x < bar)` so a NaN fails.
  if (!(medians.inProcessMs < maxColdMs)) {
    out.push(`in-process median ${medians.inProcessMs.toFixed(1)} ms; the bar is < ${maxColdMs} ms`)
  }
  if (!(medians.wallMs < maxColdMs)) {
    out.push(
      `fresh-process wall median ${medians.wallMs.toFixed(1)} ms; the bar is < ${maxColdMs} ms`,
    )
  }
  return out
}

/** Runs the cold loads and applies the bar. */
export async function measureLoad(options: {
  readonly runs: number
  readonly maxColdMs: number | undefined
}): Promise<LoadReport> {
  const dir = writeSpikeBFixture()
  const probe = fileURLToPath(new URL('load-probe.ts', import.meta.url))
  const runs: LoadSample[] = []
  try {
    for (let run = 0; run < options.runs; run++) {
      const result = await runProcess(
        process.execPath,
        ['--conditions=provino-source', probe, dir],
        { cwd: dir, env: process.env, timeoutMs: 60_000 },
      )
      const sample = readSample(result.output, KEYS)
      if (result.exitCode !== 0 || sample === undefined) {
        throw new Error(
          `bench:jest-config load: the probe exited ${result.exitCode}:\n${result.output}`,
        )
      }
      if (sample.keys !== SPIKE_B_KEYS) {
        throw new Error(`the fixture loaded ${sample.keys} keys, expected ${SPIKE_B_KEYS}`)
      }
      runs.push({ inProcessMs: sample.inProcessMs, loadMs: sample.loadMs, wallMs: result.wallMs })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const medianInProcessMs = median(runs.map((run) => run.inProcessMs))
  const medianWallMs = median(runs.map((run) => run.wallMs))
  return {
    runs,
    medianInProcessMs,
    medianLoadMs: median(runs.map((run) => run.loadMs)),
    medianWallMs,
    failures: loadFailures(
      { inProcessMs: medianInProcessMs, wallMs: medianWallMs },
      options.maxColdMs,
    ),
  }
}

/** The report as printed. */
export function formatLoadReport(report: LoadReport, maxColdMs: number | undefined): string {
  const ms = (value: number) => `${value.toFixed(1)} ms`
  const lines = [
    `jest-config load (local, Node ${process.version}, Spike B fixture, ${report.runs.length} cold runs, one fresh process each)`,
    `  in-process (import the reader, find, load): median ${ms(report.medianInProcessMs)}   (find + load alone: ${ms(report.medianLoadMs)})`,
    `  fresh process, wall:                         median ${ms(report.medianWallMs)}`,
    `  bar: ${maxColdMs === undefined ? 'none (pass --max-cold-ms)' : `< ${maxColdMs} ms on both medians`}`,
    ...report.failures.map((failure) => `FAIL ${failure}`),
  ]
  return `${lines.join('\n')}\n`
}
