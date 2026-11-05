#!/usr/bin/env node
import { main } from './internal/cli.ts'

// Not `process.exit`: the pool has stopped every worker by now, so the process ends on its own.
process.exitCode = await main(process.argv.slice(2))
