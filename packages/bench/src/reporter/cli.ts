#!/usr/bin/env node
// `pnpm bench:reporter [leg…] [--tests n] [--rounds n] [--samples n] [bar flags]` (B26 Phase 1,
// D145): the live renderer's performance bars, one leg each, on a synthetic stream of 16 workers
// and 2,000 files of 25 tests. Every number is `local`. Legs: `handlers` (the cost of each bus
// handler), `frames` (a frame at 16 busy workers), `heap` (what the reporter retains), `slow-sink`
// (events per second into a terminal whose write takes 5 ms), `first-frame` (on a pty). A bar is
// checked only when its flag is given: `--max-handler-us 1 --max-frame-p99-ms 2 --max-heap-mb 4
// --max-heap-growth-mb 0.5 --min-slow-ratio 0.98 --max-first-frame-ms 50`. `e2e` is Phase 3's and
// `html` Phase 5's. Exit 0 when nothing missed, 1 on a miss, 2 on bad usage.
import { exitOnSignals } from '@provino/harness'
import { exitCodeFor, parseOrExitUsage } from '../internal/limits.ts'
import {
  runFirstFrameLeg,
  runFramesLeg,
  runHandlersLeg,
  runHeapLeg,
  runSlowSinkLeg,
} from './legs.ts'
import {
  type FirstFrameResult,
  type FramesResult,
  type HandlersResult,
  type HeapResult,
  legLine,
  parseReporterFlags,
  type ReporterLeg,
  reporterFailures,
  type SlowSinkResult,
} from './report.ts'

// First-frame children run in process groups of their own, so Ctrl-C must end them through this hook.
exitOnSignals()

const flags = parseOrExitUsage('bench:reporter', () => parseReporterFlags(process.argv.slice(2)))
const results: {
  handlers?: HandlersResult
  frames?: FramesResult
  heap?: HeapResult
  slowSink?: SlowSinkResult
  firstFrame?: FirstFrameResult
} = {}
const node = process.version
const out: string[] = []
const say = (leg: ReporterLeg, text: string, fields: object): void => {
  out.push(text)
  out.push(legLine(leg, node, fields))
}
const fixed = (value: number, digits = 3): string => value.toFixed(digits)

out.push(
  `reporter bench (local, Node ${node}, ${process.platform} ${process.arch}; stream: 16 workers, ${flags.tests} tests of 25 a file)`,
)
for (const leg of flags.legs) {
  switch (leg) {
    case 'handlers': {
      const result = runHandlersLeg(flags.tests)
      results.handlers = result
      say(
        leg,
        `handlers: per call, timer floor ${fixed(result.timerFloorUs)} µs included\n${result.kinds
          .map(
            (k) =>
              `  ${k.kind.padEnd(12)} ${String(k.calls).padStart(8)} calls  median ${fixed(k.medianUs)} µs  p99 ${fixed(k.p99Us)} µs`,
          )
          .join('\n')}`,
        result,
      )
      break
    }
    case 'frames': {
      const result = runFramesLeg(flags.tests)
      results.frames = result
      say(
        leg,
        `frames: ${result.frames} frames at 16 busy workers, every line changed each time: median ${fixed(result.medianMs)} ms, p99 ${fixed(result.p99Ms)} ms, max ${fixed(result.maxMs)} ms, ${result.bytesPerFrame} bytes a frame`,
        result,
      )
      break
    }
    case 'heap': {
      const result = runHeapLeg(flags.tests, flags.rounds)
      results.heap = result
      say(
        leg,
        `heap: retained over a no-op reporter after GC: ${fixed(result.smallMb)} MB at ${result.smallTests} tests, ${fixed(result.largeMb)} MB at ${result.largeTests} tests, growth ${fixed(result.growthMb)} MB (median of ${result.rounds} interleaved rounds)`,
        result,
      )
      break
    }
    case 'slow-sink': {
      const result = await runSlowSinkLeg(flags.tests, flags.rounds)
      results.slowSink = result
      say(
        leg,
        `slow-sink: ${fixed(result.fastPerSec, 0)} events/s into a fast sink, ${fixed(result.slowPerSec, 0)} into a ${result.slowWriteMs} ms sink: ratio ${fixed(result.ratio, 4)} (${fixed(result.ratioWithEnd, 4)} counting the end-of-run flush; ${result.rounds} interleaved rounds)`,
        result,
      )
      break
    }
    case 'first-frame': {
      const result = await runFirstFrameLeg(flags.samples)
      results.firstFrame = result
      say(
        leg,
        `first-frame: run:start to the end of the first frame's write, on a pty: median ${fixed(result.medianMs, 2)} ms, max ${fixed(result.maxMs, 2)} ms (${result.samples} samples)`,
        result,
      )
      break
    }
  }
}
const missed = reporterFailures(results, flags)
out.push(...missed.map((miss) => `FAIL ${miss}`))
process.stdout.write(`${out.join('\n')}\n`)
process.exitCode = exitCodeFor(missed)
