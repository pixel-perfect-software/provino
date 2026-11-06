#!/usr/bin/env node
// `pnpm bench:mock [--max-create-us N] [--max-call-ratio N]`: the bench behind T4.3's two bars.
// `@provino/mock` under the Jest and Vitest mock policies, against `@vitest/spy` and `jest-mock`,
// each engine in its own process, RUNS interleaved runs, medians. Creation is ns per mock for
// `fn()`, `fn(arrow)` and `fn(function)` (a new impl closure each, mocks kept alive); a call is
// ns per call of a mock with an impl. T4.3: creation under 1 µs, calls within 1.5× `@vitest/spy`
// (`--max-create-us 1 --max-call-ratio 1.5`). Every number is `local`. Exit 0 when no bar is
// missed (or none is on), 1 when a cell misses (each is named), 2 on bad usage.
import { fileURLToPath } from 'node:url'
import { runProcess } from '@provino/harness'
import { BenchError } from '../errors.ts'
import { readSample } from '../internal/limits.ts'
import {
  CELL_LABELS,
  CREATE_CELLS,
  callRatio,
  ENGINES,
  type Engine,
  exitCodeFor,
  failures,
  medianSample,
  parseBars,
  ROUNDS,
  RUNS,
  SAMPLE_KEYS,
  type Sample,
  WARMUP_ROUNDS,
} from './report.ts'

let bars: ReturnType<typeof parseBars>
try {
  // Parsed before any run, so a mistyped bar fails at once.
  bars = parseBars(process.argv.slice(2))
} catch (error) {
  if (error instanceof BenchError && error.code === 'BENCH_USAGE') {
    process.stderr.write(`bench:mock: ${error.message}\n`)
    process.exit(2)
  }
  throw error
}

const entry = fileURLToPath(new URL('entry.ts', import.meta.url))
const samples: Record<Engine, Sample[]> = {
  'provino-jest': [],
  'provino-vitest': [],
  'vitest-spy': [],
  'jest-mock': [],
}
for (let run = 0; run < RUNS; run++) {
  // Rotate which engine goes first, so none always runs on a cooler machine.
  const order = [...ENGINES.slice(run % ENGINES.length), ...ENGINES.slice(0, run % ENGINES.length)]
  for (const engine of order) {
    const result = await runProcess(
      process.execPath,
      ['--conditions=provino-source', entry, engine],
      { cwd: process.cwd(), env: process.env, timeoutMs: 180_000 },
    )
    const sample = readSample(result.output, SAMPLE_KEYS)
    if (result.exitCode !== 0 || sample === undefined) {
      throw new Error(`bench:mock ${engine} exited ${result.exitCode}:\n${result.output}`)
    }
    samples[engine].push(sample)
  }
}

const medians = Object.fromEntries(
  ENGINES.map((engine) => [engine, medianSample(samples[engine])]),
) as Record<Engine, Sample>

const ns = (value: number): string => `${value.toFixed(0)} ns`
const width = Math.max(...ENGINES.map((engine) => engine.length)) + 2
const lines = [
  `mock bench (local, Node ${process.version}, ${process.platform} ${process.arch}, ${RUNS} interleaved runs per engine, one process each; ${ROUNDS} rounds per process, first ${WARMUP_ROUNDS} discarded, median of the rest)`,
  `  ${''.padEnd(width)}${CREATE_CELLS.map((cell) => CELL_LABELS[cell].padStart(14)).join('')}${'call'.padStart(14)}`,
  ...ENGINES.map(
    (engine) =>
      `  ${engine.padEnd(width)}${CREATE_CELLS.map((cell) => ns(medians[engine][cell]).padStart(14)).join('')}${ns(medians[engine].call).padStart(14)}`,
  ),
  `  call ratio to @vitest/spy: provino-jest ${callRatio(medians['provino-jest'], medians['vitest-spy']).toFixed(2)}×, provino-vitest ${callRatio(medians['provino-vitest'], medians['vitest-spy']).toFixed(2)}×`,
  `  call ratio to jest-mock:   provino-jest ${callRatio(medians['provino-jest'], medians['jest-mock']).toFixed(2)}×, provino-vitest ${callRatio(medians['provino-vitest'], medians['jest-mock']).toFixed(2)}×`,
]
const missed = failures(medians, bars)
lines.push(...missed)
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = exitCodeFor(missed)
