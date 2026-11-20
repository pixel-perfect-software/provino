#!/usr/bin/env node
// `pnpm bench:vitest-config sample`: the Vitest config reader against Vitest 5.0.5's own
// `resolveConfig` over the rebuilt sample (B25c, T11.15, D28's terms). Every number is `local`.
//
//   sample [--build-manifest | --fetch] [--only <id>] [--concurrency N] [--timeout-ms N]
//
// Exit 0 when every compared config was equal, 1 when one wasn't, 2 for bad usage.
import { exitOnSignals } from '@provino/harness'

exitOnSignals()

const TOOL = 'bench:vitest-config'
const [command, ...rest] = process.argv.slice(2)

if (command === 'sample') {
  const { sampleCommand } = await import('./sample.ts')
  process.exitCode = await sampleCommand(rest)
} else {
  process.stderr.write(`${TOOL}: usage: ${TOOL} sample [options]\n`)
  process.exitCode = 2
}
