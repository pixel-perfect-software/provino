#!/usr/bin/env node
// `pnpm bench:reporter [leg…] [--tests n] [--rounds n] [--samples n] [--rate n] [--write-ms n]
// [bar flags]` (B26 Phase 1,
// D145): the live renderer's performance bars, one leg each, on a synthetic stream of 16 workers
// and 2,000 files of 25 tests. Every number is `local`. Legs: `handlers` (the cost of each bus
// handler), `frames` (a frame at 16 busy workers), `heap` (what the reporter retains), `slow-sink`
// (the stream replayed at `--rate` tests a second, default 5,000, about 10 s, in 10 ms batches on
// real timers, into a fast sink and into one whose write takes `--write-ms`, default 5; 0 is the
// control: events per second, and each event's wait from its scheduled send to the end of its
// delivery, printed with no bar), `first-frame` (on a pty). A bar is
// checked only when its flag is given: `--max-handler-us 1 --max-frame-p99-ms 2 --max-heap-mb 4
// --max-heap-growth-mb 0.5 --min-slow-ratio 0.98 --max-first-frame-ms 50`. `e2e [--suite s]…
// [--runs n]` (Phase 3) runs only when named: each suite (default app-500) under the built bin on a
// pty, `--reporter provino` against `--reporter agent`, 1 discarded plus `--runs` (default 7) of
// each, interleaved: the wall ratio with its bootstrap CI and the coordinator CPU the reporter
// adds, with the bars `--max-wall-ratio 1.02 --max-cpu-overhead 0.02`. `html [--files n]
// [--html-rounds n]` (Phase 5) runs only when named: `run:end` of the HTML report (the page's build
// and write) against a reporter that writes nothing, interleaved, median of `--html-rounds` (15),
// and the page's size, for `--files` (500) files of 25 tests, all passing and with the stream's 1%
// failures, with the bars `--max-html-ms 50 --max-html-kb 400 --max-html-failures-kb 1024`
// (`--files 2000` is a signal). Exit 0 when nothing missed, 1 on a miss, 2 on bad usage.
import { exitOnSignals } from '@provino/harness'
import { exitCodeFor, parseOrExitUsage } from '../internal/limits.ts'
import { runE2eLeg } from './e2e.ts'
import { runHtmlLeg } from './html.ts'
import {
  runFirstFrameLeg,
  runFramesLeg,
  runHandlersLeg,
  runHeapLeg,
  runSlowSinkLeg,
} from './legs.ts'
import {
  type E2eResult,
  type FirstFrameResult,
  type FramesResult,
  type HandlersResult,
  type HeapResult,
  type HtmlResult,
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
  e2e?: E2eResult[]
  html?: HtmlResult
} = {}
const node = process.version
const out: string[] = []
const say = (leg: ReporterLeg, text: string, fields: object): void => {
  out.push(text)
  out.push(legLine(leg, node, fields))
}
const fixed = (value: number, digits = 3): string => value.toFixed(digits)

out.push(
  `reporter bench (local, Node ${node}, ${process.platform} ${process.arch}; stream: 16 workers, ${
    flags.legs.every((leg) => leg === 'html') ? `${flags.files} files` : `${flags.tests} tests`
  } of 25 a file)`,
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
      const result = await runSlowSinkLeg(flags.tests, flags.rounds, flags.rate, flags.writeMs)
      results.slowSink = result
      say(
        leg,
        `slow-sink: ${fixed(result.fastPerSec, 0)} events/s into a fast sink, ${fixed(result.slowPerSec, 0)} into a ${result.slowWriteMs} ms sink: ratio ${fixed(result.ratio, 4)} (${fixed(result.ratioWithEnd, 4)} counting the end-of-run flush; ${result.rounds} interleaved rounds, ${result.testsPerSec} tests/s)\n  event wait: fast median ${fixed(result.fastWaitMedianMs)} ms p99 ${fixed(result.fastWaitP99Ms)} ms; slow median ${fixed(result.slowWaitMedianMs)} ms p99 ${fixed(result.slowWaitP99Ms)} ms`,
        result,
      )
      break
    }
    case 'e2e': {
      for (const suite of flags.suites) {
        const result = await runE2eLeg(suite, flags.runs)
        results.e2e = [...(results.e2e ?? []), result]
        say(
          leg,
          `e2e ${suite}: --reporter provino against --reporter agent on a pty, ${result.runs} interleaved runs of each after one discarded: wall median ${fixed(result.provinoMedianMs, 0)} ms against ${fixed(result.agentMedianMs, 0)} ms, ratio ${fixed(result.ratio, 4)} (95% CI ${fixed(result.ratioLow, 4)} to ${fixed(result.ratioHigh, 4)}); coordinator CPU ${fixed(result.provinoCpuMs, 0)} ms against ${fixed(result.agentCpuMs, 0)} ms, ${fixed(result.cpuOverhead * 100, 2)}% added`,
          result,
        )
      }
      break
    }
    case 'html': {
      const result = await runHtmlLeg(flags.files, flags.htmlRounds)
      results.html = result
      say(
        leg,
        `html: the page at run:end for ${result.files} files of 25 tests, ${result.rounds} interleaved rounds against a reporter that writes nothing\n${result.variants
          .map(
            (v) =>
              `  ${v.name.padEnd(9)} ${String(v.tests).padStart(6)} tests, ${String(v.failures).padStart(4)} failed: run:end ${fixed(v.htmlMs, 2)} ms (build and write; ${fixed(v.noopMs, 3)} ms for the silent reporter, ${fixed(v.buildMs, 2)} ms added), ${fixed(v.kb, 1)} KB`,
          )
          .join('\n')}`,
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
