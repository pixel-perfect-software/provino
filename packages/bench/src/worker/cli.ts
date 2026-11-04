#!/usr/bin/env node
// `pnpm bench:worker check`: B10's acceptance check. Generates an app suite (app-500 by default,
// the Jest flavour) into a temporary directory and runs it through one worker with the real
// runtime, the Jest dialect and the node environment, under `registry` and then under `none`. It
// prints files, tests passed, failed and skipped, unhandled errors, file errors, leaked globals,
// ordering violations, how the worker exited and wall time for each tier, and exits 1 unless every
// tier has all its tests passing and none of the rest.
//   --suite app-N        the suite (default app-500)
//   --pool inline|threads|forks   the worker’s transport (default inline)
// Every number is labelled `local`; this is a pass/fail check, not a Track 12 BenchRecord.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { expectedTests } from '../suites.ts'
import { checkSuite, describeTier, writeJestSuite } from './check.ts'
import { POOLS } from './run.ts'

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    suite: { type: 'string', default: 'app-500' },
    pool: { type: 'string', default: 'inline' },
  },
})

const lines: string[] = []
let ok = true
if (positionals[0] === 'check') {
  const pool = POOLS.find((candidate) => candidate === args.pool)
  if (pool === undefined) {
    throw new BenchError('BENCH_USAGE', `--pool is one of ${POOLS.join(', ')}, not "${args.pool}"`)
  }
  const suite = await writeJestSuite(args.suite)
  try {
    const checks = await checkSuite(suite, pool)
    ok = checks.every((check) => check.ok)
    lines.push(
      `worker check (local, Node ${process.version}, ${suite.spec.name} jest flavour, one ${pool} worker)`,
      ...checks.flatMap(describeTier),
    )
    if (!ok) {
      lines.push(
        `FAIL the bar is ${expectedTests(suite.spec)} passed, and 0 failed, unhandled, file errors, leaked globals and order violations, and worker exit 0, in each tier`,
      )
    }
  } finally {
    await suite.cleanup()
  }
} else {
  ok = false
  lines.push('usage: bench:worker check [--suite app-N] [--pool inline|threads|forks]')
}
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = ok ? 0 : 1
