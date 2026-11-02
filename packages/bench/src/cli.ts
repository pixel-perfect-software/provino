#!/usr/bin/env node
import { runCli } from './commands.ts'
import { exitOnSignals } from './exec.ts'

exitOnSignals()
process.exitCode = await runCli(process.argv.slice(2))
