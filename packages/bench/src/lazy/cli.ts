#!/usr/bin/env node
// `pnpm bench:lazy check`: Track 6's behaviours on the real core, under the Jest dialect's policy
// and the neutral one (T6.5). Prints each failure to stderr and `{"checks":N,"failed":F}` to stdout.
// Exit 0 when nothing failed, 1 when a check failed, 2 on bad usage.
import { runLazyCheck } from './check.ts'

const command = process.argv[2]
if (command !== 'check' || process.argv.length > 3) {
  console.error('usage: bench:lazy check')
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
