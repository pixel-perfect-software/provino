#!/usr/bin/env node
// `pnpm bench:hoist [--max-mocked-ms N] [--max-unmocked-ms N]`: the cost bar of T3.4 (build-plan
// B13b): `hoistMocks` alone, under the Jest dialect's policy, on a generated 15 KB ESM test file
// with mocks and static imports (the import rewrite, the worst case) and on the same size without
// a mock call. RUNS fresh processes (`entry.ts`), medians. The bars from the brief are
// `--max-mocked-ms 10 --max-unmocked-ms 0.05`, on Node 24. Every number is `local`. Exit 0 when no
// bar is missed (or none is on), 1 when a cell misses (each is named), 2 on bad usage.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { exitOnSignals, runProcess } from '@provino/harness'
import { BenchError } from '../errors.ts'
import { readSample } from '../internal/limits.ts'
import {
  CELL_LABELS,
  CELLS,
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

// Each child runs in its own process group, so Ctrl-C must end them through this hook.
exitOnSignals()

let bars: ReturnType<typeof parseBars>
try {
  // Parsed before any run, so a mistyped bar fails at once.
  bars = parseBars(process.argv.slice(2))
} catch (error) {
  if (error instanceof BenchError && error.code === 'BENCH_USAGE') {
    process.stderr.write(`bench:hoist: ${error.message}\n`)
    process.exit(2)
  }
  throw error
}

/**
 * Whether raw transfer is available here, asked of the `oxc-parser` that `@provino/transform`
 * resolves (the one the hoister parses with, which uses raw transfer wherever the platform has
 * it). `bench` does not depend on `oxc-parser` itself.
 */
function rawTransfer(): string {
  try {
    const fromTransform = createRequire(import.meta.resolve('@provino/transform'))
    const parser: unknown = fromTransform('oxc-parser')
    const supported: unknown =
      typeof parser === 'object' && parser !== null
        ? Reflect.get(parser, 'rawTransferSupported')
        : undefined
    if (typeof supported !== 'function') return 'unknown (oxc-parser has no rawTransferSupported)'
    return supported() === true ? 'yes (experimentalRawTransfer)' : 'no (JSON AST)'
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`
  }
}

const entry = fileURLToPath(new URL('entry.ts', import.meta.url))
const samples: Sample[] = []
for (let run = 0; run < RUNS; run++) {
  const result = await runProcess(process.execPath, ['--conditions=provino-source', entry], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 180_000,
  })
  const sample = readSample(result.output, SAMPLE_KEYS)
  if (result.exitCode !== 0 || sample === undefined) {
    throw new Error(`bench:hoist run ${run + 1} exited ${result.exitCode}:\n${result.output}`)
  }
  samples.push(sample)
}

const medians = medianSample(samples)
const missed = failures(medians, bars)
const lines = [
  `hoist bench (local, Node ${process.version}, ${process.platform} ${process.arch}, ${RUNS} fresh processes, ${ROUNDS} rounds each, first ${WARMUP_ROUNDS} discarded, median of the rest; 15 KB generated ESM test file, seed fixed)`,
  ...CELLS.map(
    (cell) =>
      `  ${cell.padEnd(10)}${CELL_LABELS[cell].padEnd(14)}${medians[cell].toFixed(4).padStart(10)} ms per call`,
  ),
  `  raw transfer: ${rawTransfer()}`,
  '  mocked includes the import rewrite (the worst case); `hoistMocks` alone, parse included',
  ...missed,
]
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = exitCodeFor(missed)
