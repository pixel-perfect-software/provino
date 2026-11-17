// The pure part of `bench:watch` (T9.11): flags, the probe's lines, the bar, and the lines printed.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { overBar, parseLimit, pastLimit } from '../internal/limits.ts'
import { max, median, min } from '../stats.ts'

/** Who is run: `provino jest --watch`, or Jest 30.5.2's `--watch` as a signal. */
export type WatchSubject = 'provino' | 'jest'

/** What the command line asks for. */
export interface WatchFlags {
  /** `--max-ms`: the bar on Provino's median, or none. */
  readonly maxMs: number | undefined
  /** `--saves`: saves per session (T9.11: 20). */
  readonly saves: number
  /** `--runner jest`: also run Jest, for the ratio. */
  readonly withJest: boolean
  /** `--sessions`: sessions per subject, alternating which goes first. */
  readonly sessions: number
  /** `--files`: the tree's size. */
  readonly files: number
  /** `--settle-ms`: the quiet after a run ends before the next save. */
  readonly settleMs: number
  /** `--keep`: leave the tree in `$TMPDIR` and print where. */
  readonly keep: boolean
}

export const DEFAULT_SAVES = 20
export const DEFAULT_FILES = 5_000
/** Jest drops a change that lands while a run is finishing (`watch.ts` L284-287), so a save waits this long after one. */
export const DEFAULT_SETTLE_MS = 250

function whole(flag: string, text: string | undefined, fallback: number, min = 1): number {
  if (text === undefined) return fallback
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min) {
    throw new BenchError(
      'BENCH_USAGE',
      `--${flag} needs a whole number of at least ${min}, got "${text}"`,
    )
  }
  return value
}

/** Parses `bench:watch`'s flags; a `BENCH_USAGE` error on anything else. */
export function parseWatchFlags(argv: readonly string[]): WatchFlags {
  let values: Readonly<Record<string, string | boolean | undefined>>
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        'max-ms': { type: 'string' },
        saves: { type: 'string' },
        runner: { type: 'string' },
        sessions: { type: 'string' },
        files: { type: 'string' },
        'settle-ms': { type: 'string' },
        keep: { type: 'boolean' },
      },
    }).values
  } catch (cause) {
    throw new BenchError('BENCH_USAGE', errorMessage(cause), { cause })
  }
  const text = (name: string): string | undefined => {
    const value = values[name]
    return typeof value === 'string' ? value : undefined
  }
  const runner = text('runner')
  if (runner !== undefined && runner !== 'jest') {
    throw new BenchError('BENCH_USAGE', `--runner takes jest (as a signal), got "${runner}"`)
  }
  const withJest = runner === 'jest'
  const files = whole('files', text('files'), DEFAULT_FILES, 2)
  return {
    maxMs: parseLimit('max-ms', text('max-ms')),
    saves: whole('saves', text('saves'), DEFAULT_SAVES),
    withJest,
    // One session has nothing to interleave with; with Jest two of each do.
    sessions: whole('sessions', text('sessions'), withJest ? 2 : 1),
    files,
    settleMs: whole('settle-ms', text('settle-ms'), DEFAULT_SETTLE_MS, 0),
    keep: values.keep === true,
  }
}

/** One line the probe reporter wrote: what happened and when (epoch ms). */
export interface ProbeEvent {
  readonly kind: 'run' | 'start' | 'done'
  readonly at: number
}

/** The line as an event, or `undefined` for anything else on the descriptor. */
export function parseProbeLine(line: string): ProbeEvent | undefined {
  const match = /^(run|start|done) (\d+(?:\.\d+)?)$/.exec(line.trim())
  const kind = match?.[1]
  const at = Number(match?.[2])
  return (kind === 'run' || kind === 'start' || kind === 'done') && Number.isFinite(at)
    ? { kind, at }
    : undefined
}

/**
 * What the header says of the tree's size: nothing when the tree has the files asked for, else the
 * count it has (the tests and their chains must divide the count evenly, so it can differ).
 */
export function filesNote(requested: number, generated: number): string | undefined {
  return requested === generated
    ? undefined
    : `--files ${requested} does not divide into whole chains of modules under their tests: the tree has ${generated} files`
}

/** Every save of every session of one subject. */
export type WatchSamples = Readonly<Record<WatchSubject, readonly number[]>>

/** What one subject's saves came to. */
export interface WatchSummary {
  readonly median: number
  readonly min: number
  readonly max: number
  readonly count: number
}

export function summarize(samples: readonly number[]): WatchSummary {
  return { median: median(samples), min: min(samples), max: max(samples), count: samples.length }
}

/** What missed: Provino's median over `maxMs`, or no saves measured. Empty when nothing missed. */
export function watchFailures(
  samples: WatchSamples,
  expected: number,
  maxMs: number | undefined,
): string[] {
  const missed: string[] = []
  for (const subject of ['provino', 'jest'] as const) {
    const count = samples[subject].length
    if (subject === 'provino' || count > 0) {
      if (count !== expected) {
        missed.push(`${subject}: ${count} of ${expected} saves measured; every one must be`)
      }
    }
  }
  if (maxMs !== undefined && samples.provino.length > 0) {
    const value = median(samples.provino)
    if (overBar(value, maxMs)) {
      missed.push(
        `provino jest --watch: median ${pastLimit(value, maxMs, 1)} ms from save to first file start is over the bar of ${maxMs} ms (T9.11)`,
      )
    }
  }
  return missed
}

const ms = (value: number): string => `${value.toFixed(1)} ms`

/** The lines `bench:watch` prints after the header. */
export function watchLines(
  samples: WatchSamples,
  flags: WatchFlags,
  names: Readonly<Record<WatchSubject, string>>,
): string[] {
  const lines: string[] = []
  const summaries: Partial<Record<WatchSubject, WatchSummary>> = {}
  for (const subject of ['provino', 'jest'] as const) {
    if (samples[subject].length === 0) continue
    const summary = summarize(samples[subject])
    summaries[subject] = summary
    lines.push(
      `  ${names[subject].padEnd(22)} median ${ms(summary.median).padStart(10)}   min ${ms(summary.min)}   max ${ms(summary.max)}   ${summary.count} saves`,
      `  ${''.padEnd(22)} saves: ${samples[subject].map((value) => value.toFixed(0)).join(' ')}`,
    )
  }
  const ours = summaries.provino
  const theirs = summaries.jest
  if (ours !== undefined && theirs !== undefined) {
    lines.push(`  ratio provino/jest: ${(ours.median / theirs.median).toFixed(3)} (medians)`)
  }
  if (flags.maxMs !== undefined) {
    lines.push(`  bar: median ≤${flags.maxMs} ms, provino only (T9.11)`)
  }
  return lines
}
