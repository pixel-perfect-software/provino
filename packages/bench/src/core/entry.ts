#!/usr/bin/env node
// One process of `bench:core` (T5.14): `ROUNDS` passes of the core workload in one configuration
// (`off`, `on` or `turns`: `CORE_SETUPS`), the first `WARMUP_ROUNDS` discarded, and prints
// `PROVINO_SAMPLE {"usPerTest": µs, "passed": n, "eventsPerTest": n}` (the median of the kept
// rounds). Usage: entry.ts <off|on|turns>. Every number is `local`.
import { keptMedian, ROUNDS, SAMPLE_PREFIX, WARMUP_ROUNDS } from '../internal/limits.ts'
import { CORE_SETUPS, coreConfigOf } from './report.ts'
import { CORE_TESTS, runCorePass } from './workload.ts'

const { locations, turns } = CORE_SETUPS[coreConfigOf(process.argv[2])]
const perTest: number[] = []
let passed = Number.POSITIVE_INFINITY
let events = 0
for (let round = 0; round < ROUNDS; round++) {
  const pass = await runCorePass(locations, CORE_TESTS, turns)
  perTest.push((pass.elapsedMs * 1000) / CORE_TESTS)
  passed = Math.min(passed, pass.passed)
  events = pass.events
}
process.stdout.write(
  `${SAMPLE_PREFIX}${JSON.stringify({
    usPerTest: keptMedian(perTest, WARMUP_ROUNDS),
    passed,
    eventsPerTest: events / CORE_TESTS,
  })}\n`,
)
