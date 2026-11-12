#!/usr/bin/env node
// `pnpm bench:expect-import [--max-cold-ms N] [--runs N]`: T7.12's bar. How long a fresh Node
// process takes to import the built `provino` entry and the worker-side `expect` behind it
// (`provino/dist/worker/jest-runtime.js`: the engine, the Jest dialect's table, pretty-format).
// Track 7's number to beat is Jest's `expect` at 63 ms; the bar is ≤ 40 ms on Node 24. Each run is
// its own process (a cold import is the point), after one that is discarded. Every number is
// `local`: not a Track 12 R5 BenchRecord. It needs `provino` built: `pnpm bench:expect-import`
// builds it first.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runProcess } from '@provino/harness'
import { BenchError } from '../errors.ts'
import { parseLimit, parseOrExitUsage, readSample } from '../internal/limits.ts'
import { describeRun, type ImportSample, KEYS, summarise } from './report.ts'

const DEFAULT_RUNS = 15

const { maxColdMs, runs } = parseOrExitUsage('bench:expect-import', () => {
  const { values } = parseArgs({
    options: { 'max-cold-ms': { type: 'string' }, runs: { type: 'string' } },
  })
  const count = values.runs === undefined ? DEFAULT_RUNS : parseLimit('runs', values.runs)
  if (count === undefined || !Number.isInteger(count) || count < 1) {
    throw new BenchError('BENCH_USAGE', '--runs needs a whole number of at least 1')
  }
  return { maxColdMs: parseLimit('max-cold-ms', values['max-cold-ms']), runs: count }
})

const dist = join(dirname(fileURLToPath(import.meta.resolve('provino/package.json'))), 'dist')
if (!existsSync(join(dist, 'worker', 'jest-runtime.js'))) {
  process.stderr.write(
    `bench:expect-import: ${dist} has no build: run \`pnpm --filter provino build\` first\n`,
  )
  process.exit(2)
}

const entry = fileURLToPath(new URL('entry.ts', import.meta.url))
const samples: ImportSample[] = []
for (let run = 0; run <= runs; run++) {
  // Run 0 warms the file cache and is not kept.
  const result = await runProcess(process.execPath, [entry, dist], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 120_000,
  })
  const sample = readSample(result.output, KEYS)
  if (result.exitCode !== 0 || sample === undefined) {
    throw new Error(`bench:expect-import run ${run} exited ${result.exitCode}:\n${result.output}`)
  }
  if (run > 0) samples.push(sample)
}

const { lines, ok } = describeRun(summarise(samples), {
  processes: runs,
  node: process.version,
  maxColdMs,
})
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = ok ? 0 : 1
