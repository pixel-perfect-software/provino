#!/usr/bin/env node
// `pnpm bench:core [--max-us N] [--runs N]`: T5.14's bar, rebuilt from Track 5's deleted
// `collector/bench-core.ts`. The real runtime collects and runs one file of 10,000 empty tests
// with three hooks around each (two `beforeEach`, one `afterEach`), every attempt in its own
// AsyncLocalStorage store, under the Jest dialect's core policy. Two configurations, each in its
// own processes, interleaved: locations off (the spike's "Locations off + ALS run()" column, which
// the bar names) and locations on (how the worker runs core today, a signal with no bar). Each
// process runs 8 passes, the first 2 discarded, and reports the median µs per test; the line is the
// median of `--runs` processes (default 5). T5.14: ≤5 µs on Node 24 (`--max-us 5`). Every number
// is `local`. Exit 0 when nothing missed (or no bar is on), 1 on a miss, 2 on bad usage.
import { fileURLToPath } from 'node:url'
import { exitOnSignals, runProcess } from '@provino/harness'
import {
  exitCodeFor,
  parseOrExitUsage,
  ROUNDS,
  readSample,
  WARMUP_ROUNDS,
} from '../internal/limits.ts'
import {
  BARRED_CONFIG,
  CORE_CONFIGS,
  CORE_SAMPLE_KEYS,
  type CoreSample,
  coreFailures,
  medianCore,
  parseCoreFlags,
} from './report.ts'
import { CORE_HOOKS_PER_TEST, CORE_TESTS, type CoreLocations } from './workload.ts'

// Each child runs in its own process group, so Ctrl-C must end them through this hook.
exitOnSignals()

const flags = parseOrExitUsage('bench:core', () => parseCoreFlags(process.argv.slice(2)))
const entry = fileURLToPath(new URL('entry.ts', import.meta.url))
const samples: Record<CoreLocations, CoreSample[]> = { off: [], on: [] }
for (let run = 0; run < flags.runs; run++) {
  // Alternate which configuration goes first, so neither always runs on a cooler machine.
  const order = run % 2 === 0 ? CORE_CONFIGS : CORE_CONFIGS.toReversed()
  for (const config of order) {
    const result = await runProcess(
      process.execPath,
      ['--conditions=provino-source', entry, config],
      { cwd: process.cwd(), env: process.env, timeoutMs: 300_000 },
    )
    const sample = readSample(result.output, CORE_SAMPLE_KEYS)
    if (result.exitCode !== 0 || sample === undefined) {
      throw new Error(`bench:core locations ${config} exited ${result.exitCode}:\n${result.output}`)
    }
    samples[config].push(sample)
  }
}

const medians: Record<CoreLocations, CoreSample> = {
  off: medianCore(samples.off),
  on: medianCore(samples.on),
}
const us = (value: number): string => `${value.toFixed(2)} µs`
const lines = [
  `core bench (local, Node ${process.version}, ${process.platform} ${process.arch}; ${CORE_TESTS} empty tests, ${CORE_HOOKS_PER_TEST} hooks each, Jest policy; ${flags.runs} interleaved processes per configuration, ${ROUNDS} passes each, first ${WARMUP_ROUNDS} discarded)`,
  ...CORE_CONFIGS.map(
    (config) =>
      `  locations ${config}${config === BARRED_CONFIG ? ' + ALS (T5.14)' : ' (signal)     '} ${us(medians[config].usPerTest).padStart(10)} per test   runs ${samples[config].map((sample) => sample.usPerTest.toFixed(2)).join(' ')}   ${medians[config].eventsPerTest.toFixed(0)} events per test, ${medians[config].passed}/${CORE_TESTS} passed`,
  ),
  ...(flags.maxUs === undefined ? [] : [`  bar: ≤${flags.maxUs} µs per test, locations off + ALS`]),
]
const missed = coreFailures(medians, CORE_TESTS, flags.maxUs)
lines.push(...missed.map((miss) => `FAIL ${miss}`))
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = exitCodeFor(missed)
