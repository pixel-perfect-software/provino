// The pure part of `bench:core` (T5.14): flags, the bar, and the lines it prints.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { overBar, parseLimit, pastLimit } from '../internal/limits.ts'
import { median } from '../stats.ts'
import type { CoreLocations } from './workload.ts'

/**
 * The configurations `bench:core` measures, the barred one first: locations off with ALS (the
 * spike's "Locations off + ALS `run()`" column, which T5.14's bar names), then locations on (how
 * the worker runs core today), a signal with no bar.
 * @public
 */
export const CORE_CONFIGS: readonly CoreLocations[] = ['off', 'on']

/**
 * The configuration T5.14's bar applies to.
 * @public
 */
export const BARRED_CONFIG: CoreLocations = 'off'

/**
 * One process's sample: the median µs per test of its kept rounds.
 * @public
 */
export interface CoreSample {
  readonly usPerTest: number
  /** The fewest tests any round passed: every round must pass all of them. */
  readonly passed: number
  readonly eventsPerTest: number
}

/**
 * The keys a child's `PROVINO_SAMPLE` line carries.
 * @public
 */
export const CORE_SAMPLE_KEYS: readonly ['usPerTest', 'passed', 'eventsPerTest'] = [
  'usPerTest',
  'passed',
  'eventsPerTest',
]

/**
 * What the command line asks for.
 * @public
 */
export interface CoreFlags {
  /** `--max-us`: the bar on µs per test (locations off), or none. */
  readonly maxUs: number | undefined
  /** `--runs`: processes per configuration. */
  readonly runs: number
}

/**
 * Processes per configuration by default.
 * @public
 */
export const DEFAULT_CORE_RUNS = 5

/**
 * Parses `bench:core`'s flags; a `BENCH_USAGE` error on anything else.
 * @public
 */
export function parseCoreFlags(argv: readonly string[]): CoreFlags {
  let values: { readonly 'max-us'?: string | undefined; readonly runs?: string | undefined }
  try {
    values = parseArgs({
      args: [...argv],
      options: { 'max-us': { type: 'string' }, runs: { type: 'string' } },
    }).values
  } catch (cause) {
    throw new BenchError('BENCH_USAGE', errorMessage(cause), { cause })
  }
  const runsText = values.runs
  const runs = runsText === undefined ? DEFAULT_CORE_RUNS : Number(runsText)
  if (runsText !== undefined && (!/^[1-9]\d*$/.test(runsText) || !Number.isSafeInteger(runs))) {
    throw new BenchError('BENCH_USAGE', `--runs needs a positive whole number, got "${runsText}"`)
  }
  return { maxUs: parseLimit('max-us', values['max-us']), runs }
}

/**
 * The median of the processes' samples for one configuration.
 * @public
 */
export function medianCore(samples: readonly CoreSample[]): CoreSample {
  return {
    usPerTest: median(samples.map((sample) => sample.usPerTest)),
    passed: Math.min(...samples.map((sample) => sample.passed)),
    eventsPerTest: median(samples.map((sample) => sample.eventsPerTest)),
  }
}

/**
 * What missed: a configuration whose tests did not all pass, and the barred configuration over
 * `maxUs`. Empty when nothing missed.
 * @public
 */
export function coreFailures(
  medians: Readonly<Record<CoreLocations, CoreSample>>,
  tests: number,
  maxUs: number | undefined,
): string[] {
  const missed: string[] = []
  for (const config of CORE_CONFIGS) {
    const { passed } = medians[config]
    if (passed !== tests) {
      missed.push(`locations ${config}: ${passed}/${tests} tests passed; every one must`)
    }
  }
  const barred = medians[BARRED_CONFIG].usPerTest
  if (maxUs !== undefined && overBar(barred, maxUs)) {
    missed.push(
      `locations ${BARRED_CONFIG} + ALS: ${pastLimit(barred, maxUs, 2)} µs per test is over the bar of ${maxUs} µs (T5.14)`,
    )
  }
  return missed
}
