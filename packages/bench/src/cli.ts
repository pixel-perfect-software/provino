#!/usr/bin/env node
import { exitOnSignals } from '@provino/harness'
import { runCli } from './commands.ts'

exitOnSignals()
process.exitCode = await runCli(process.argv.slice(2))
