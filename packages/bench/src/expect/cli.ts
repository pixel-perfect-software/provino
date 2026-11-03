#!/usr/bin/env node
// `pnpm bench:expect [--max-tobe-us N] [--max-toequal-us N]`: Track 7's spike F, ported (B08).
// Passing `toBe` and `toEqual` through the Jest dialect's `expect` on `@provino/expect` against
// `expect@30.5.2`, each engine in its own process (they can't share a realm), runs interleaved.
// The numbers are medians per call over the runs; T7.3's bar is ≤ 1 µs per `toBe` and ≤ 4 µs per
// `toEqual` on Node 24. Every number is labelled `local`: an in-process micro-benchmark, not a
// Track 12 R5 BenchRecord.
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runProcess } from '@provino/harness'
import { parseLimit, readSample } from '../internal/limits.ts'
import { median } from '../stats.ts'

const RUNS = 5
const ENGINES = ['provino', 'jest'] as const
type Engine = (typeof ENGINES)[number]
const KEYS = ['toBe', 'toEqual'] as const
type Sample = Record<(typeof KEYS)[number], number>

const { values: args } = parseArgs({
  options: {
    'max-tobe-us': { type: 'string' },
    'max-toequal-us': { type: 'string' },
  },
})

// Parsed before any run, so a mistyped bar fails at once.
const bars = {
  toBe: parseLimit('max-tobe-us', args['max-tobe-us']),
  toEqual: parseLimit('max-toequal-us', args['max-toequal-us']),
}

const entry = fileURLToPath(new URL('entry.ts', import.meta.url))
const samples: Record<Engine, Sample[]> = { provino: [], jest: [] }
for (let run = 0; run < RUNS; run++) {
  // Alternate which engine goes first, so neither always runs on a cooler machine.
  const order = run % 2 === 0 ? ENGINES : [...ENGINES].reverse()
  for (const engine of order) {
    const result = await runProcess(
      process.execPath,
      ['--conditions=provino-source', entry, engine],
      { cwd: process.cwd(), env: process.env, timeoutMs: 120_000 },
    )
    // The sample is the output's `PROVINO_SAMPLE` line with both timings; stderr (warnings) shares
    // the tail.
    const sample = readSample(result.output, KEYS)
    if (result.exitCode !== 0 || sample === undefined) {
      throw new Error(`bench:expect ${engine} exited ${result.exitCode}:\n${result.output}`)
    }
    samples[engine].push(sample)
  }
}

const us = (ns: number): string => `${(ns / 1000).toFixed(2)} µs`
const medians = (engine: Engine) => ({
  toBe: median(samples[engine].map((s) => s.toBe)),
  toEqual: median(samples[engine].map((s) => s.toEqual)),
})
const provino = medians('provino')
const jest = medians('jest')
// `toBe` is padded to the width of `toEqual`, plus two spaces.
const labelWidth = Math.max(...KEYS.map((key) => key.length)) + 2
const lines = [
  `expect bench (local, Node ${process.version}, ${RUNS} interleaved runs per engine, median per call)`,
  ...KEYS.map(
    (key) =>
      `  ${key.padEnd(labelWidth)}provino ${us(provino[key])}   jest ${us(jest[key])}   jest/provino ${(jest[key] / provino[key]).toFixed(1)}×`,
  ),
]
let ok = true
for (const key of KEYS) {
  const bar = bars[key]
  // Written `!(measured <= bar)` so a NaN measurement fails the bar instead of passing it.
  if (bar !== undefined && !(provino[key] / 1000 <= bar)) {
    ok = false
    lines.push(`FAIL provino ${key} is ${us(provino[key])}; the bar is ≤ ${bar} µs`)
  }
}
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = ok ? 0 : 1
