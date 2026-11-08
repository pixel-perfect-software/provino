#!/usr/bin/env node
// `pnpm bench:jest-config load|presets|sample`: the Jest config reader against real jest-config
// 30.5.2 (B14b). Every number is `local`.
//
//   load [--max-cold-ms N] [--runs N]   T11.4: the Spike B fixture's cold load, in-process and wall
//   presets                              T11.5: real presets (oracle/presets/), deep-equal readConfig
//   sample [--build-manifest | --fetch] [--only <id>] [--concurrency N]
//                                        T11.6: the rebuilt sample (D28), local only
//
// Exit 0 when every check passed, 1 when one failed, 2 for bad usage.
import { parseArgs } from 'node:util'
import { exitOnSignals } from '@provino/harness'
import { BenchError } from '../errors.ts'
import { parseLimit, parseOrExitUsage } from '../internal/limits.ts'
import { formatLoadReport, LOAD_RUNS, measureLoad } from './load.ts'

exitOnSignals()

const TOOL = 'bench:jest-config'
const [command, ...rest] = process.argv.slice(2)

function positiveInteger(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BenchError('BENCH_USAGE', `--${flag} needs a whole number ≥ 1, got "${value}"`)
  }
  return parsed
}

if (command === 'load') {
  const options = parseOrExitUsage(TOOL, () => {
    const { values } = parseArgs({
      args: rest,
      options: { 'max-cold-ms': { type: 'string' }, runs: { type: 'string' } },
    })
    return {
      maxColdMs: parseLimit('max-cold-ms', values['max-cold-ms']),
      runs: positiveInteger('runs', values.runs, LOAD_RUNS),
    }
  })
  const report = await measureLoad(options)
  process.stdout.write(formatLoadReport(report, options.maxColdMs))
  process.exitCode = report.failures.length === 0 ? 0 : 1
} else if (command === 'presets') {
  const { presetsCommand } = await import('./presets.ts')
  process.exitCode = await presetsCommand(rest)
} else if (command === 'sample') {
  const { sampleCommand } = await import('./sample.ts')
  process.exitCode = await sampleCommand(rest)
} else {
  process.stderr.write(`${TOOL}: usage: ${TOOL} load|presets|sample [options]\n`)
  process.exitCode = 2
}
