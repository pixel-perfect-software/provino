// T6.8's bar: a memoized lazy read stays under 3x an ALS + Map getter, in the same run. One test on
// the real core, under the Jest dialect's whole policy, with the lazy slot installed. Inside it,
// rounds alternate between the baseline (its own `AsyncLocalStorage.run`, a `Map` in the store, the
// read is `als.getStore().get(key)`) and `$.k` after its first read has memoized the value. The
// numbers are the median ns per read over the rounds. `local`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { parseArgs } from 'node:util'
import { jestPolicy } from '@provino/dialect-jest'
import { installLazyRuntime, type LazyRuntime, lazy as publicLazy } from '@provino/lazy'
import { resolvePolicy } from '@provino/policy'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { overBar, parseLimit } from '../internal/limits.ts'
import { median } from '../stats.ts'
import { runFile } from './run.ts'

/** What the command line asks for. */
export interface ReadsFlags {
  /** `--max-ratio`: the bar on lazy ns / baseline ns. */
  readonly maxRatio: number
  /** `--rounds`: interleaved rounds, after one discarded. */
  readonly rounds: number
  /** `--reads`: reads per round per side. */
  readonly reads: number
}

/** The one JSON line the command prints. */
export interface ReadsResult {
  readonly label: 'local'
  readonly node: string
  readonly baselineNs: number
  readonly lazyNs: number
  readonly ratio: number
}

const DEFAULT_MAX_RATIO = 3
const DEFAULT_ROUNDS = 7
const DEFAULT_READS = 1_000_000

function positiveWhole(flag: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  const value = Number(text)
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value)) {
    throw new BenchError('BENCH_USAGE', `--${flag} needs a positive whole number, got "${text}"`)
  }
  return value
}

/** Parses the flags after `reads`; a `BENCH_USAGE` error on anything else. */
export function parseReadsFlags(argv: readonly string[]): ReadsFlags {
  let values: Readonly<Record<string, string | undefined>>
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        'max-ratio': { type: 'string' },
        rounds: { type: 'string' },
        reads: { type: 'string' },
      },
    }).values
  } catch (cause) {
    throw new BenchError('BENCH_USAGE', errorMessage(cause), { cause })
  }
  return {
    maxRatio: parseLimit('max-ratio', values['max-ratio']) ?? DEFAULT_MAX_RATIO,
    rounds: positiveWhole('rounds', values.rounds, DEFAULT_ROUNDS),
    reads: positiveWhole('reads', values.reads, DEFAULT_READS),
  }
}

/** Measures both sides inside one test on the real core. */
export async function measureReads(
  flags: Pick<ReadsFlags, 'rounds' | 'reads'>,
): Promise<ReadsResult> {
  const baselineRounds: number[] = []
  const lazyRounds: number[] = []
  const result = await runFile(resolvePolicy(jestPolicy), ({ api, lazyRuntime }) => {
    const uninstall = installLazyRuntime({ lazy: lazyRuntime.lazy } as unknown as LazyRuntime)
    const $ = publicLazy.let('k', () => 41)
    api.test('reads', () => {
      const als = new AsyncLocalStorage<Map<string, number>>()
      const timeBaseline = (): number => {
        const store = new Map<string, number>([['k', 41]])
        return als.run(store, () => {
          let sum = 0
          const start = process.hrtime.bigint()
          for (let i = 0; i < flags.reads; i++) sum += als.getStore()?.get('k') ?? 0
          const ns = Number(process.hrtime.bigint() - start)
          if (sum !== 41 * flags.reads) throw new Error('baseline read the wrong value')
          return ns / flags.reads
        })
      }
      const timeLazy = (): number => {
        let sum = 0
        const start = process.hrtime.bigint()
        for (let i = 0; i < flags.reads; i++) sum += $.k
        const ns = Number(process.hrtime.bigint() - start)
        if (sum !== 41 * flags.reads) throw new Error('lazy read the wrong value')
        return ns / flags.reads
      }
      void $.k // the first read evaluates; every read after it is memoized
      // Round 0 is warm-up and thrown away; the rest alternate which side goes first.
      for (let round = 0; round <= flags.rounds; round++) {
        let baseline: number
        let lazyNs: number
        if (round % 2 === 1) {
          lazyNs = timeLazy()
          baseline = timeBaseline()
        } else {
          baseline = timeBaseline()
          lazyNs = timeLazy()
        }
        if (round > 0) {
          baselineRounds.push(baseline)
          lazyRounds.push(lazyNs)
        }
      }
    })
    api.afterAll(uninstall)
  })
  const state = result.states.reads
  if (state !== 'pass') {
    const detail = (result.errors.reads ?? []).map((error) => error.message).join('; ')
    throw new Error(`the read test ${state ?? 'did not run'}: ${detail}`)
  }
  const baselineNs = median(baselineRounds)
  const lazyNs = median(lazyRounds)
  return { label: 'local', node: process.version, baselineNs, lazyNs, ratio: lazyNs / baselineNs }
}

/** Whether the ratio misses the bar (a NaN ratio misses). */
export function missesBar(result: ReadsResult, maxRatio: number): boolean {
  return overBar(result.ratio, maxRatio)
}
