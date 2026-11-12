#!/usr/bin/env node
import { main } from './internal/cli.ts'
import { handleSignals } from './internal/signals.ts'

// How long the process gets to end by itself once a second signal has killed the workers. The run
// ends on its own as soon as the pool reports its last worker gone; this is the bound on
// everything else (a reporter that never settles), and the one place a bin exits with
// `process.exit`: library code never does (T9.10).
const FORCE_GRACE_MS = 750

/** Waits until what was written to `stream` has been handed to the operating system. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve())
  })
}

const signals = handleSignals(process, {
  // The second Ctrl+C: the workers are killed now; the process follows within the grace.
  onForce: () => {
    setTimeout(() => process.exit(signals.exitCode() ?? 1), FORCE_GRACE_MS).unref()
  },
})

let forceExit = false
const code = await main(process.argv.slice(2), {
  signal: signals.signal,
  forceSignal: signals.forceSignal,
  onForceExit: () => {
    forceExit = true
  },
})
signals.dispose()
// A run the user cut short ends with the signal's code (130, 143) even when it had nothing left to
// interrupt: Ctrl+C while the workers were still stopping is still a Ctrl+C.
const finalCode = signals.exitCode() ?? code
process.exitCode = finalCode
// The run is over. If something a test left open keeps the process alive (an inline pool), a signal
// now means "stop waiting": the process ends at once, with the signal's code rather than by the
// signal, so a Ctrl+C that lands just after the run is the same as one during it. Handlers do not
// keep the event loop alive.
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

// `--forceExit`: end the process now, as Jest does, once what the run printed has been written. A
// run that wasn't asked to leaves the exit to the event loop: with forks or threads the pool has
// stopped every worker, so it ends on its own. `--pool inline` shares this process, so a test's
// leaked handle (a timer, a socket) keeps it alive, as with Jest's `--runInBand`.
if (forceExit) {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)])
  process.exit(finalCode)
}
