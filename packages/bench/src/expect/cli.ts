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

const RUNS = 5
const ENGINES = ['provino', 'jest'] as const
type Engine = (typeof ENGINES)[number]
interface Sample {
  readonly toBe: number
  readonly toEqual: number
}

const { values: args } = parseArgs({
  options: {
    'max-tobe-us': { type: 'string' },
    'max-toequal-us': { type: 'string' },
  },
})

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
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
    // The sample is the output's one JSON line; stderr (warnings) shares the tail.
    const line = result.output.split('\n').find((text) => text.startsWith('{'))
    if (result.exitCode !== 0 || line === undefined) {
      throw new Error(`bench:expect ${engine} exited ${result.exitCode}:\n${result.output}`)
    }
    samples[engine].push(JSON.parse(line) as Sample)
  }
}

const us = (ns: number): string => `${(ns / 1000).toFixed(2)} µs`
const medians = (engine: Engine) => ({
  toBe: median(samples[engine].map((s) => s.toBe)),
  toEqual: median(samples[engine].map((s) => s.toEqual)),
})
const provino = medians('provino')
const jest = medians('jest')
const lines = [
  `expect bench (local, Node ${process.version}, ${RUNS} interleaved runs per engine, median per call)`,
  `  toBe     provino ${us(provino.toBe)}   jest ${us(jest.toBe)}   jest/provino ${(jest.toBe / provino.toBe).toFixed(1)}×`,
  `  toEqual  provino ${us(provino.toEqual)}   jest ${us(jest.toEqual)}   jest/provino ${(jest.toEqual / provino.toEqual).toFixed(1)}×`,
]
let ok = true
for (const [flag, key] of [
  ['max-tobe-us', 'toBe'],
  ['max-toequal-us', 'toEqual'],
] as const) {
  const bar = args[flag]
  if (bar === undefined) continue
  if (provino[key] / 1000 > Number(bar)) {
    ok = false
    lines.push(`FAIL provino ${key} is ${us(provino[key])}; the bar is ≤ ${bar} µs`)
  }
}
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = ok ? 0 : 1
