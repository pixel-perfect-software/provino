#!/usr/bin/env node
// One process's side of `bench:hoist` (T3.4): times `hoistMocks` alone, under the Jest dialect's
// hoist policy, on a generated 15 KB ESM test file with mocks (the import rewrite, the worst case)
// and on the same size without a mock call, and prints
// `PROVINO_SAMPLE {"mocked": ms, "unmocked": ms}`. Milliseconds per call. The files are generated
// in memory from a fixed seed. Each cell runs ROUNDS rounds of several calls; the first
// WARMUP_ROUNDS are discarded, the rest are medians.
import { jestHoistPolicy } from '@provino/dialect-jest'
import { hoistMocks } from '@provino/transform'
import { keptMedian, ROUNDS, SAMPLE_PREFIX, WARMUP_ROUNDS } from '../internal/limits.ts'
import { generateTestFile, HOIST_CALL_PATTERN } from './generate.ts'
import { CALLS_PER_ROUND, CELLS, type Cell, SEED, TARGET_BYTES } from './report.ts'

const FILENAME = '/virtual/bench.test.ts'
const inputs: Record<Cell, string> = {
  mocked: generateTestFile({ seed: SEED, mocked: true, targetBytes: TARGET_BYTES }),
  unmocked: generateTestFile({ seed: SEED, mocked: false, targetBytes: TARGET_BYTES }),
}

/** What the timed calls must have done, or the number says nothing about the work. */
function assertDidTheWork(cell: Cell): void {
  // The prefilter in `hoistMocks` skips a file with no hoistable call, so the unmocked cell times
  // the prefilter alone. Prove the inputs are what the cells say: a hoistable call, or none.
  const hasCall = HOIST_CALL_PATTERN.test(inputs[cell])
  if (cell === 'mocked' && !hasCall) {
    throw new Error('bench:hoist mocked: the generated file has no hoistable call')
  }
  if (cell === 'unmocked' && hasCall) {
    throw new Error('bench:hoist unmocked: the generated file has a hoistable call')
  }
  const output = hoistMocks(inputs[cell], jestHoistPolicy, { filename: FILENAME })
  const failed = output.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  if (failed !== undefined)
    throw new Error(`bench:hoist ${cell}: hoisting failed: ${failed.message}`)
  if (cell === 'mocked' && (!output.rewroteImports || output.staticMocks.length === 0)) {
    throw new Error(
      `bench:hoist mocked: the file was not hoisted (rewroteImports ${output.rewroteImports}, ${output.staticMocks.length} static mocks)`,
    )
  }
  if (cell === 'unmocked' && (output.rewroteImports || output.code !== inputs.unmocked)) {
    throw new Error('bench:hoist unmocked: the file without mocks was changed')
  }
}

/** Every output length, summed and printed, so the optimizer can't drop the calls. */
let sink = 0

function time(cell: Cell): number {
  const perRound: number[] = []
  const calls = CALLS_PER_ROUND[cell]
  const input = inputs[cell]
  for (let round = 0; round < ROUNDS; round++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < calls; i++) {
      sink += hoistMocks(input, jestHoistPolicy, { filename: FILENAME }).code.length
    }
    perRound.push(Number(process.hrtime.bigint() - start) / 1e6 / calls)
  }
  return keptMedian(perRound, WARMUP_ROUNDS)
}

for (const cell of CELLS) assertDidTheWork(cell)
const result = { mocked: time('mocked'), unmocked: time('unmocked') }
process.stderr.write(`bench:hoist: output length sum ${sink}\n`)
process.stdout.write(`${SAMPLE_PREFIX}${JSON.stringify(result)}\n`)
