#!/usr/bin/env node
import { missingBindingMessage } from './internal/native-binding.ts'
import { USAGE } from './internal/usage.ts'
import { packageVersion } from './internal/version.ts'

// `--version` and `--help` need nothing a run needs, so they answer before the rest is imported:
// the rest includes the Oxc native bindings, which a machine may lack (T10.3).
const argv = process.argv.slice(2)
if (argv[0] === '--version') {
  process.stdout.write(`${packageVersion()}\n`)
} else if (argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(USAGE)
} else {
  try {
    const { main } = await import('./internal/cli.ts')
    // Not `process.exit`: with forks or threads the pool has stopped every worker by now, so the
    // process ends on its own. With `--pool inline` the worker shares this process, so a test's
    // leaked handle (a timer, a socket) keeps it alive, as with Jest's `--runInBand`;
    // `--forceExit` is T9.10.
    process.exitCode = await main(argv)
  } catch (error) {
    // An Oxc binding that didn't load fails the import, before `main` runs: one message, no stack.
    const message = missingBindingMessage(error)
    if (message === undefined) throw error
    process.stderr.write(message)
    process.exitCode = 1
  }
}
