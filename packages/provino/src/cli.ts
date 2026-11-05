#!/usr/bin/env node
import { main } from './internal/cli.ts'

// Not `process.exit`: with forks or threads the pool has stopped every worker by now, so the
// process ends on its own. With `--pool inline` the worker shares this process, so a test's leaked
// handle (a timer, a socket) keeps it alive, as with Jest's `--runInBand`; `--forceExit` is T9.10.
process.exitCode = await main(process.argv.slice(2))
