#!/usr/bin/env node
// `pnpm bench:worker check`: B10's acceptance check. Generates an app suite (app-500 by default,
// the Jest flavour) into a temporary directory and runs it through one worker with the real
// runtime, the Jest dialect and the node environment, under `registry` and then under `none`. It
// prints files, tests passed, failed and total, ordering violations and wall time for each tier,
// and exits 1 unless every tier has all its tests passing, none failing and no violation.
//   --suite app-N        the suite (default app-500)
//   --pool inline|threads|forks   the worker’s transport (default inline)
// Every number is labelled `local`; this is a pass/fail check, not a Track 12 BenchRecord.
import { parseArgs } from 'node:util'
import type { PoolKind } from '@provino/types'
import { BenchError } from '../errors.ts'
import { checkSuite, describeTier, writeJestSuite } from './check.ts'

const POOLS: readonly string[] = ['inline', 'threads', 'forks']

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
  if (!POOLS.includes(args.pool)) {
    throw new BenchError('BENCH_USAGE', `--pool is one of ${POOLS.join(', ')}, not "${args.pool}"`)
  }
  const suite = await writeJestSuite(args.suite)
  try {
    const checks = await checkSuite(suite, { pool: args.pool as PoolKind })
    lines.push(
      `worker check (local, Node ${process.version}, ${suite.spec.name} jest flavour, one ${args.pool} worker)`,
    )
    for (const check of checks) {
      lines.push(...describeTier(check))
      if (!check.ok) ok = false
    }
    if (!ok) {
      lines.push(
        `FAIL the bar is ${checks[0]?.expected} passed, 0 failed, 0 unhandled and 0 order violations in each tier`,
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
