// The pure part of `bench:reporter` (B26 Phase 1): the flags, the statistics, the bars and the JSON
// line each leg prints. Nothing here runs a reporter. Every number is `local`.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { overBar, parseLimit, pastLimit } from '../internal/limits.ts'
import { median, quantile } from '../stats.ts'

/** The legs this phase builds; `e2e` is Phase 3's and `html` Phase 5's. */
export const REPORTER_LEGS = ['handlers', 'frames', 'heap', 'slow-sink', 'first-frame'] as const
export type ReporterLeg = (typeof REPORTER_LEGS)[number]

const LATER_LEGS: Readonly<Record<string, string>> = {
  e2e: 'Phase 3 (it needs the flag plumbing)',
  html: 'Phase 5 (the HTML report)',
}

/**
 * The parsed command line.
 * @public
 */
export interface ReporterFlags {
  readonly legs: readonly ReporterLeg[]
  /** Tests in the stream; default 50,000. */
  readonly tests: number
  /** Interleaved rounds for the heap and slow-sink legs. */
  readonly rounds: number
  /** First-frame samples. */
  readonly samples: number
  /** The slow-sink leg's replay rate, in tests per second; default 5,000. */
  readonly rate: number
  /** The slow sink's write time in ms; default 5, and 0 is the control. */
  readonly writeMs: number
  readonly maxHandlerUs: number | undefined
  readonly maxFrameP99Ms: number | undefined
  readonly maxHeapMb: number | undefined
  readonly maxHeapGrowthMb: number | undefined
  readonly minSlowRatio: number | undefined
  readonly maxFirstFrameMs: number | undefined
}

function whole(flag: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  const value = Number(text)
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value)) {
    throw new BenchError('BENCH_USAGE', `--${flag} needs a positive whole number, got "${text}"`)
  }
  return value
}

/**
 * Parses `bench:reporter`'s arguments: leg names (none or `all` is every leg), `--tests`,
 * `--rounds`, `--samples` and the bar flags. A `BENCH_USAGE` error on anything else.
 * @public
 */
export function parseReporterFlags(argv: readonly string[]): ReporterFlags {
  let parsed: ReturnType<typeof parse>
  function parse() {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        tests: { type: 'string' },
        rounds: { type: 'string' },
        samples: { type: 'string' },
        rate: { type: 'string' },
        'write-ms': { type: 'string' },
        'max-handler-us': { type: 'string' },
        'max-frame-p99-ms': { type: 'string' },
        'max-heap-mb': { type: 'string' },
        'max-heap-growth-mb': { type: 'string' },
        'min-slow-ratio': { type: 'string' },
        'max-first-frame-ms': { type: 'string' },
      },
    })
  }
  try {
    parsed = parse()
  } catch (cause) {
    throw new BenchError('BENCH_USAGE', errorMessage(cause), { cause })
  }
  const legs: ReporterLeg[] = []
  for (const name of parsed.positionals) {
    if (name === 'all') {
      legs.push(...REPORTER_LEGS)
    } else if ((REPORTER_LEGS as readonly string[]).includes(name)) {
      legs.push(name as ReporterLeg)
    } else if (LATER_LEGS[name] !== undefined) {
      throw new BenchError('BENCH_USAGE', `the ${name} leg is built in ${LATER_LEGS[name]}`)
    } else {
      throw new BenchError(
        'BENCH_USAGE',
        `unknown leg "${name}": one of ${REPORTER_LEGS.join(', ')}, or all`,
      )
    }
  }
  const { values } = parsed
  return {
    legs: legs.length === 0 ? REPORTER_LEGS : [...new Set(legs)],
    tests: whole('tests', values.tests, 50_000),
    rounds: whole('rounds', values.rounds, 5),
    samples: whole('samples', values.samples, 30),
    rate: whole('rate', values.rate, 5000),
    writeMs: parseLimit('write-ms', values['write-ms']) ?? 5,
    maxHandlerUs: parseLimit('max-handler-us', values['max-handler-us']),
    maxFrameP99Ms: parseLimit('max-frame-p99-ms', values['max-frame-p99-ms']),
    maxHeapMb: parseLimit('max-heap-mb', values['max-heap-mb']),
    maxHeapGrowthMb: parseLimit('max-heap-growth-mb', values['max-heap-growth-mb']),
    minSlowRatio: parseLimit('min-slow-ratio', values['min-slow-ratio']),
    maxFirstFrameMs: parseLimit('max-first-frame-ms', values['max-first-frame-ms']),
  }
}

/** One event kind's handler cost. */
export interface HandlerKind {
  readonly kind: string
  readonly calls: number
  readonly medianUs: number
  readonly p99Us: number
}

/** `handlers`: the cost of each handled event kind, in µs of one call. */
export interface HandlersResult {
  readonly kinds: readonly HandlerKind[]
  /** The clock's own cost per reading pair, which every timed call includes. */
  readonly timerFloorUs: number
  readonly events: number
}

/** `frames`: one frame's cost, in ms. */
export interface FramesResult {
  readonly frames: number
  readonly medianMs: number
  readonly p99Ms: number
  readonly maxMs: number
  readonly bytesPerFrame: number
}

/** `heap`: what the reporter retains after GC beyond a no-op reporter, in MB. */
export interface HeapResult {
  readonly smallTests: number
  readonly largeTests: number
  readonly smallMb: number
  readonly largeMb: number
  readonly growthMb: number
  readonly rounds: number
}

/**
 * `slow-sink`: events per second into a fast sink and a slow one, on a stream replayed at a steady
 * rate, and how long each event waited from its scheduled send to the end of its delivery.
 */
export interface SlowSinkResult {
  readonly fastPerSec: number
  readonly slowPerSec: number
  readonly ratio: number
  /** The same, counting the end-of-run flush (the slow sink pays its write there). */
  readonly ratioWithEnd: number
  readonly slowWriteMs: number
  /** The replay's rate, in tests per second. */
  readonly testsPerSec: number
  /** Each event's wait in ms (medians over the rounds); printed, with no bar. */
  readonly fastWaitMedianMs: number
  readonly fastWaitP99Ms: number
  readonly slowWaitMedianMs: number
  readonly slowWaitP99Ms: number
  readonly rounds: number
}

/** `first-frame`: from `run:start` to the end of the first frame's write, in ms. */
export interface FirstFrameResult {
  readonly samples: number
  readonly medianMs: number
  readonly maxMs: number
}

/** Rule 1's exceptions: handlers that do a run's work once. */
const ONCE_PER_RUN: ReadonlySet<string> = new Set(['run:start', 'run:end'])

/**
 * The statistics of a handler's timings, in µs.
 * @public
 */
export function handlerKind(kind: string, ns: readonly number[]): HandlerKind {
  const us = ns.map((value) => value / 1000)
  return { kind, calls: us.length, medianUs: median(us), p99Us: quantile(us, 0.99) }
}

/**
 * The bars that missed, as text. Empty when none did. A bar that is not set is not checked.
 * @public
 */
export function reporterFailures(
  results: {
    readonly handlers?: HandlersResult
    readonly frames?: FramesResult
    readonly heap?: HeapResult
    readonly slowSink?: SlowSinkResult
    readonly firstFrame?: FirstFrameResult
  },
  flags: ReporterFlags,
): string[] {
  const missed: string[] = []
  const { handlers, frames, heap, slowSink, firstFrame } = results
  if (flags.maxHandlerUs !== undefined && handlers !== undefined) {
    for (const kind of handlers.kinds) {
      if (ONCE_PER_RUN.has(kind.kind)) continue
      if (overBar(kind.medianUs, flags.maxHandlerUs)) {
        missed.push(
          `handler ${kind.kind} median ${pastLimit(kind.medianUs, flags.maxHandlerUs, 3)} µs is over ${flags.maxHandlerUs} µs`,
        )
      }
    }
  }
  if (flags.maxFrameP99Ms !== undefined && frames !== undefined) {
    if (overBar(frames.p99Ms, flags.maxFrameP99Ms)) {
      missed.push(
        `frame p99 ${pastLimit(frames.p99Ms, flags.maxFrameP99Ms, 3)} ms is over ${flags.maxFrameP99Ms} ms`,
      )
    }
  }
  if (heap !== undefined) {
    if (flags.maxHeapMb !== undefined && overBar(heap.smallMb, flags.maxHeapMb)) {
      missed.push(
        `retained heap ${pastLimit(heap.smallMb, flags.maxHeapMb, 3)} MB at ${heap.smallTests} tests is over ${flags.maxHeapMb} MB`,
      )
    }
    if (flags.maxHeapGrowthMb !== undefined && overBar(heap.growthMb, flags.maxHeapGrowthMb)) {
      missed.push(
        `heap growth ${pastLimit(heap.growthMb, flags.maxHeapGrowthMb, 3)} MB to ${heap.largeTests} tests is over ${flags.maxHeapGrowthMb} MB`,
      )
    }
  }
  if (flags.minSlowRatio !== undefined && slowSink !== undefined) {
    // Written so a NaN ratio misses.
    if (!(slowSink.ratio >= flags.minSlowRatio)) {
      missed.push(
        `slow-sink throughput ratio ${pastLimit(slowSink.ratio, flags.minSlowRatio, 4)} is under ${flags.minSlowRatio}`,
      )
    }
  }
  if (flags.maxFirstFrameMs !== undefined && firstFrame !== undefined) {
    if (overBar(firstFrame.medianMs, flags.maxFirstFrameMs)) {
      missed.push(
        `first frame median ${pastLimit(firstFrame.medianMs, flags.maxFirstFrameMs, 2)} ms is over ${flags.maxFirstFrameMs} ms`,
      )
    }
  }
  return missed
}

/**
 * The one JSON line a leg prints: its label (always `local`), the Node it ran on and its numbers.
 * @public
 */
export function legLine(leg: ReporterLeg, node: string, fields: object): string {
  return JSON.stringify({ label: 'local', leg, node, ...fields })
}
