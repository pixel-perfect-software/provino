#!/usr/bin/env node
import { exitOnSignals } from '@provino/harness'
import { runCli } from './commands.ts'
import { ignoreBrokenPipe } from './internal/broken-pipe.ts'

exitOnSignals()
// A reader that closes early (`| head`) must not lose the record the run still has to save.
ignoreBrokenPipe(process.stdout)
ignoreBrokenPipe(process.stderr)
process.exitCode = await runCli(process.argv.slice(2))
