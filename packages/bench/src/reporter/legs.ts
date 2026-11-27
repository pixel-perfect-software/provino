// The legs of `bench:reporter` (B26 Phase 1): each one measures one performance rule of the live
// renderer on the synthetic stream. They run in this process (the first-frame leg starts children
// on a pty). Every number is `local`. The `e2e` leg arrives with Phase 3 and `html` with Phase 5.
import { fileURLToPath } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { groupExists, spawnPty } from '@provino/harness'
import { createReporterBus } from '@provino/reporters'
import {
  createFrameScheduler,
  type FrameScheduler,
  GLYPHS,
  provinoReporter,
  type TerminalStream,
} from '@provino/reporters/live'
import type { Reporter, ReporterEvents, ReporterHandlers } from '@provino/types'
import { BenchError } from '../errors.ts'
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { median, quantile } from '../stats.ts'
import { type PaceClock, realPaceClock, waitUntil } from './pace.ts'
import {
  type FirstFrameResult,
  type FramesResult,
  type HandlersResult,
  type HeapResult,
  handlerKind,
  type SlowSinkResult,
} from './report.ts'
import { buildStream, type StreamEvent, specForTests, streamEvents } from './stream.ts'

const COLUMNS = 120

/** A sink that counts what it is given. */
function countingSink(writeMs = 0): TerminalStream & { readonly bytes: () => number } {
  let bytes = 0
  return {
    write(chunk) {
      bytes += chunk.length
      if (writeMs > 0) {
        // A slow terminal: the write is synchronous and holds the caller.
        const until = performance.now() + writeMs
        while (performance.now() < until) {
          // Spin.
        }
      }
      return true
    },
    bytes: () => bytes,
  }
}

/** A frame scheduler that runs a frame only when the leg says so, on a clock the leg moves. */
interface BenchScheduler extends FrameScheduler {
  runFrame(): void
  advance(ms: number): void
}

function benchScheduler(start = 0): BenchScheduler {
  let frame: (() => number | undefined) | undefined
  let time = start
  return {
    bind(callback) {
      frame = callback
    },
    request() {},
    observeWrite() {},
    stop() {},
    now: () => time,
    runFrame() {
      frame?.()
    },
    advance(ms) {
      time += ms
    },
  }
}

export type AnyHandler = (...args: readonly unknown[]) => unknown

export function handlerOf(reporter: Reporter, name: keyof ReporterEvents): AnyHandler | undefined {
  const handlers: ReporterHandlers = reporter
  return handlers[name] as unknown as AnyHandler | undefined
}

/** `event` delivered to `reporter`'s handler for it, if it has one. */
export function deliver(reporter: Reporter, event: StreamEvent): unknown {
  return handlerOf(reporter, event.name)?.apply(reporter, event.args)
}

/** A reporter that has nothing to do: the baseline a reporter's cost is read against. */
export function noopReporter(): Reporter {
  return { name: 'noop' }
}

function newReporter(stream: TerminalStream, scheduler: FrameScheduler): Reporter {
  return provinoReporter({
    stream,
    live: true,
    colour: false,
    columns: COLUMNS,
    glyphs: GLYPHS.emoji,
    hyperlinks: false,
    cwd: '/project',
    scheduler,
  })
}

/** `handlers`: each handler called directly over the stream, one call timed at a time. */
export function runHandlersLeg(tests: number): HandlersResult {
  const stream = buildStream(specForTests(tests))
  const scheduler = benchScheduler()
  const reporter = newReporter(countingSink(), scheduler)
  const timings = new Map<string, number[]>()
  const PASSES = 4
  for (let pass = 0; pass < PASSES; pass++) {
    for (const event of stream.events) {
      const handler = handlerOf(reporter, event.name)
      if (handler === undefined) continue
      const start = performance.now()
      handler.apply(reporter, event.args)
      const ns = (performance.now() - start) * 1e6
      if (pass === 0) continue // the first pass warms the code
      let list = timings.get(event.name)
      if (list === undefined) {
        list = []
        timings.set(event.name, list)
      }
      list.push(ns)
    }
  }
  // What a pair of clock readings costs on its own: every timed call includes it.
  const floor: number[] = []
  for (let i = 0; i < 20_000; i++) {
    const start = performance.now()
    floor.push((performance.now() - start) * 1e6)
  }
  return {
    kinds: [...timings].map(([kind, ns]) => handlerKind(kind, ns)),
    timerFloorUs: median(floor) / 1000,
    events: stream.counts.events,
  }
}

/** `frames`: state at 16 busy workers and `tests` tests done, then 1,000 worst-case frames. */
export function runFramesLeg(tests: number): FramesResult {
  const spec = specForTests(tests)
  const stream = buildStream(spec)
  const starts: number[] = []
  for (const [i, event] of stream.events.entries()) if (event.name === 'file:start') starts.push(i)
  const waveStart = starts[starts.length - spec.workers] as number
  const cut = stream.events.findIndex((event, i) => i > waveStart && event.name === 'file:end')
  const sink = countingSink()
  const scheduler = benchScheduler()
  const reporter = newReporter(sink, scheduler)
  for (let i = 0; i < cut; i++) {
    deliver(reporter, stream.events[i] as StreamEvent)
  }
  const pool = stream.events.slice(waveStart, cut).filter((event) => event.name === 'task:end')
  const taskEnd = handlerOf(reporter, 'task:end') as AnyHandler
  const FRAMES = 1000
  const times: number[] = []
  scheduler.runFrame() // the first frame draws everything; the bytes below are of the rest
  const before = sink.bytes()
  for (let i = 0; i < FRAMES + 100; i++) {
    // Every frame finds something new: a test ended, and a tenth of a second passed, so each
    // worker's clock and the status line's have changed.
    scheduler.advance(100)
    const event = pool[i % pool.length] as StreamEvent
    taskEnd.apply(reporter, event.args)
    const start = performance.now()
    scheduler.runFrame()
    const ms = performance.now() - start
    if (i >= 100) times.push(ms) // 100 frames warm the code
  }
  return {
    frames: FRAMES,
    medianMs: median(times),
    p99Ms: quantile(times, 0.99),
    maxMs: Math.max(...times),
    bytesPerFrame: Math.round((sink.bytes() - before) / (FRAMES + 100)),
  }
}

function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc
  if (collect === undefined) {
    throw new BenchError(
      'BENCH_USAGE',
      'the heap leg needs --expose-gc (pnpm bench:reporter passes it)',
    )
  }
  collect()
  collect()
}

/** What `make`'s reporter keeps after playing a stream of `spec` through it, in bytes. */
function retainedBytes(
  spec: ReturnType<typeof specForTests>,
  make: () => Reporter,
  frames: BenchScheduler | undefined,
): number {
  gc()
  const before = getHeapStatistics().used_heap_size
  const reporter = make()
  let n = 0
  for (const event of streamEvents(spec)) {
    deliver(reporter, event)
    if (frames !== undefined && ++n % 500 === 0) {
      frames.advance(100)
      frames.runFrame()
    }
  }
  gc()
  const after = getHeapStatistics().used_heap_size
  // The reporter must still be reachable when the heap is read.
  if (reporter.name === '') throw new Error('unreachable')
  return after - before
}

/**
 * `heap`: the reporter against a no-op reporter on the same stream at `tests` and at four times as
 * many, the same number of failures in both, interleaved over `rounds`.
 */
export function runHeapLeg(tests: number, rounds: number): HeapResult {
  const FAILURES = 50
  const small = specForTests(tests, { failures: FAILURES })
  const large = specForTests(tests * 4, { failures: FAILURES })
  const overhead: Record<'small' | 'large', number[]> = { small: [], large: [] }
  for (let round = 0; round < rounds + 1; round++) {
    for (const [name, spec] of [
      ['small', small],
      ['large', large],
    ] as const) {
      const measure = (subject: 'provino' | 'noop'): number => {
        if (subject === 'noop') return retainedBytes(spec, noopReporter, undefined)
        const scheduler = benchScheduler()
        return retainedBytes(spec, () => newReporter(countingSink(), scheduler), scheduler)
      }
      // The first side alternates, so neither always runs on a warmer heap.
      const order =
        round % 2 === 0 ? (['noop', 'provino'] as const) : (['provino', 'noop'] as const)
      const results = { noop: 0, provino: 0 }
      for (const subject of order) results[subject] = measure(subject)
      if (round > 0) overhead[name].push(results.provino - results.noop) // round 0 is discarded
    }
  }
  const mb = (bytes: number): number => bytes / (1024 * 1024)
  const smallMb = mb(median(overhead.small))
  const largeMb = mb(median(overhead.large))
  return {
    smallTests: small.files * small.testsPerFile,
    largeTests: large.files * large.testsPerFile,
    smallMb,
    largeMb,
    growthMb: largeMb - smallMb,
    rounds,
  }
}

/** The width of a batch of the paced replay: events due in each 10 ms are sent together. */
export const BATCH_MS = 10

/** What one paced replay measured. */
interface PacedRun {
  readonly perSec: number
  readonly withEndPerSec: number
  readonly waitMedianMs: number
  readonly waitP99Ms: number
}

/**
 * The stream through the bus into a sink, with the real scheduler, at `testsPerSec`: the events
 * are spread evenly over the run's time and sent in batches, each at its slot on the monotonic
 * clock (`start + k x 10 ms`). A batch is never sent before its slot (`waitUntil`), so no wait is
 * negative; one that is late is sent as soon as the loop is free, never skipped, and the loop
 * yields between events' turns so the frame timer can fire. Each event's wait is the time from its
 * batch's scheduled send to the end of its delivery through the bus.
 */
async function pacedReplay(
  events: readonly StreamEvent[],
  tests: number,
  testsPerSec: number,
  sink: TerminalStream,
  clock: PaceClock,
): Promise<PacedRun> {
  const reporter = provinoReporter({
    stream: sink,
    live: true,
    colour: false,
    columns: COLUMNS,
    glyphs: GLYPHS.emoji,
    hyperlinks: false,
    cwd: '/project',
    scheduler: createFrameScheduler(),
  })
  const bus = createReporterBus([reporter])
  const emit = bus.emit.bind(bus) as (name: string, ...args: readonly unknown[]) => Promise<void>
  const last = events.length - 1
  const durationMs = (tests / testsPerSec) * 1000
  const waits = new Float64Array(last)
  const start = clock.now()
  let sent = 0
  for (let batch = 0; sent < last; batch++) {
    const due = start + batch * BATCH_MS
    await waitUntil(due, clock)
    const upTo = Math.min(last, Math.ceil((((batch + 1) * BATCH_MS) / durationMs) * last))
    for (; sent < upTo; sent++) {
      const event = events[sent] as StreamEvent
      await emit(event.name, ...event.args)
      waits[sent] = clock.now() - due
    }
  }
  const beforeEnd = clock.now()
  const endEvent = events[last] as StreamEvent
  await emit(endEvent.name, ...endEvent.args)
  const end = clock.now()
  const all = Array.from(waits)
  return {
    perSec: (last / (beforeEnd - start)) * 1000,
    withEndPerSec: (events.length / (end - start)) * 1000,
    waitMedianMs: median(all),
    waitP99Ms: quantile(all, 0.99),
  }
}

/**
 * `slow-sink`: the stream replayed at `testsPerSec` (default 5,000: about 10 s for 50,000 tests)
 * through the bus with the real scheduler, into a fast sink and into one whose `write` takes
 * `writeMs`, interleaved over `rounds`. Both sides are one sink implementation; `writeMs` 0 is
 * the control. The throughput runs from the first event to the last delivered before `run:end`:
 * its flush is the one write nobody can skip, and `ratioWithEnd` counts it. The wait of each event
 * is printed for both, with no bar. `clock` is the one the replay reads and waits on (the real one
 * by default); a test gives a fake, so the pacing is checked without real time. A slow sink spins
 * on the real clock, so a fake clock with `writeMs` above 0 is refused: it would measure nothing.
 */
export async function runSlowSinkLeg(
  tests: number,
  rounds: number,
  testsPerSec = 5000,
  writeMs = 5,
  clock: PaceClock = realPaceClock,
): Promise<SlowSinkResult> {
  if (clock !== realPaceClock && writeMs > 0) {
    throw new RangeError(
      `a slow sink (writeMs ${writeMs}) spins on real time, so it cannot run on a fake clock`,
    )
  }
  const stream = buildStream(specForTests(tests))
  const runs: Record<'fast' | 'slow', PacedRun[]> = { fast: [], slow: [] }
  for (let round = 0; round < rounds + 1; round++) {
    const order = round % 2 === 0 ? (['fast', 'slow'] as const) : (['slow', 'fast'] as const)
    for (const subject of order) {
      const result = await pacedReplay(
        stream.events,
        stream.counts.tests,
        testsPerSec,
        countingSink(subject === 'fast' ? 0 : writeMs),
        clock,
      )
      if (round > 0) runs[subject].push(result) // the first round is discarded
    }
  }
  const of = (subject: 'fast' | 'slow', pick: (run: PacedRun) => number): number =>
    median(runs[subject].map(pick))
  return {
    fastPerSec: of('fast', (r) => r.perSec),
    slowPerSec: of('slow', (r) => r.perSec),
    ratio: of('slow', (r) => r.perSec) / of('fast', (r) => r.perSec),
    ratioWithEnd: of('slow', (r) => r.withEndPerSec) / of('fast', (r) => r.withEndPerSec),
    slowWriteMs: writeMs,
    testsPerSec,
    fastWaitMedianMs: of('fast', (r) => r.waitMedianMs),
    fastWaitP99Ms: of('fast', (r) => r.waitP99Ms),
    slowWaitMedianMs: of('slow', (r) => r.waitMedianMs),
    slowWaitP99Ms: of('slow', (r) => r.waitP99Ms),
    rounds,
  }
}

/**
 * `first-frame`: a child on a pty (the harness's `spawnPty`) builds the reporter, plays `run:start`
 * and the start of 16 files into its own terminal, and prints the time from `run:start` to the end
 * of the first frame's write. The child's process start is not in it: it measures the renderer.
 */
export async function runFirstFrameLeg(samples: number): Promise<FirstFrameResult> {
  const entry = fileURLToPath(new URL('first-frame-entry.ts', import.meta.url))
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    const pty = await spawnPty([process.execPath, '--conditions=provino-source', entry], {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: undefined, NO_COLOR: undefined },
      deadline: controller.signal,
    })
    try {
      await pty.waitFor(SAMPLE_PREFIX)
      const output = pty.output()
      const line = output.split('\n').find((text) => text.startsWith(SAMPLE_PREFIX))
      const parsed: unknown =
        line === undefined ? undefined : JSON.parse(line.slice(SAMPLE_PREFIX.length))
      const ms =
        typeof parsed === 'object' && parsed !== null
          ? Reflect.get(parsed, 'firstFrameMs')
          : undefined
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new BenchError('BENCH_LEG_FAILED', `first-frame child printed no sample:\n${output}`)
      }
      times.push(ms)
      await pty.exit
    } finally {
      clearTimeout(timer)
      await pty.kill()
    }
    // `kill()` waits until the group is gone; this is the probe that says so.
    if (groupExists(pty.childPgid)) {
      throw new BenchError(
        'BENCH_LEG_FAILED',
        `the first-frame child's group ${pty.childPgid} is still there`,
      )
    }
  }
  return { samples, medianMs: median(times), maxMs: Math.max(...times) }
}
