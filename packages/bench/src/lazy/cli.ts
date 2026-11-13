#!/usr/bin/env node
// `pnpm bench:lazy check`: Track 6's behaviours on the real core, under the Jest dialect's policy
// and the neutral one (T6.5). Prints each failure to stderr and `{"checks":N,"failed":F}` to stdout.
// Exit 0 when nothing failed, 1 when a check failed, 2 on bad usage.
// `pnpm bench:lazy reads [--max-ratio 3] [--rounds 7] [--reads 1000000]`: T6.8's bar, a memoized
// read against an ALS + Map getter; prints one JSON line labelled `local`. Exit 1 on a miss.
import { parseOrExitUsage } from '../internal/limits.ts'
import { runLazyCheck } from './check.ts'
import { measureReads, missesBar, parseReadsFlags } from './reads.ts'

const command = process.argv[2]
if (command === 'reads') {
  const flags = parseOrExitUsage('bench:lazy reads', () => parseReadsFlags(process.argv.slice(3)))
  const result = await measureReads(flags)
  console.log(JSON.stringify(result))
  const missed = missesBar(result, flags.maxRatio)
  if (missed) {
    console.error(`bench:lazy reads: ratio ${result.ratio} is over the bar ${flags.maxRatio}`)
  }
  process.exit(missed ? 1 : 0)
}
if (command !== 'check' || process.argv.length > 3) {
  console.error('usage: bench:lazy check | reads [--max-ratio n] [--rounds n] [--reads n]')
  process.exit(2)
}
const summary = await runLazyCheck()
for (const result of summary.results) {
  if (!result.ok) {
    console.error(`FAIL [${result.policy}] ${result.behaviour}\n  ${result.failure}`)
  }
}
console.log(JSON.stringify({ checks: summary.checks, failed: summary.failed }))
process.exit(summary.failed === 0 ? 0 : 1)
