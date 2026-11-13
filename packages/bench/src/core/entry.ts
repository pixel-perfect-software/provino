#!/usr/bin/env node
// One process of `bench:core` (T5.14): `ROUNDS` passes of the core workload with locations `on`
// or `off`, the first `WARMUP_ROUNDS` discarded, and prints
// `PROVINO_SAMPLE {"usPerTest": µs, "passed": n, "eventsPerTest": n}` (the median of the kept
// rounds). Usage: entry.ts <on|off>. Every number is `local`.
import { keptMedian, ROUNDS, SAMPLE_PREFIX, WARMUP_ROUNDS } from '../internal/limits.ts'
import { CORE_TESTS, type CoreLocations, runCorePass } from './workload.ts'

const locations: CoreLocations = process.argv[2] === 'off' ? 'off' : 'on'
const perTest: number[] = []
let passed = Number.POSITIVE_INFINITY
let events = 0
for (let round = 0; round < ROUNDS; round++) {
  const pass = await runCorePass(locations)
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
