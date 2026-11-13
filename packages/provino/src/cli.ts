#!/usr/bin/env node
import { main } from './internal/cli.ts'
import { handleSignals } from './internal/signals.ts'

// How long the process gets to end by itself once a second signal has killed the workers. This bin is
// the one place that calls `process.exit`: library code never does (T9.10).
const FORCE_GRACE_MS = 750

/** Waits until what was written to `stream` has been handed to the operating system. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve())
  })
}

const signals = handleSignals(process, {
  // Set as the signal lands, not once `main` returns: a run left with nothing to hold the event loop
  // open (a reporter that never settles) would otherwise end on the unsettled `await` below with
  // Node's 13.
  onFirst: (exitCode) => {
    process.exitCode = exitCode
  },
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
// A signal that came ends the process with its code even when there was nothing left to interrupt
// (a Ctrl+C while the workers were still stopping, or during `--listTests`).
const finalCode = signals.exitCode() ?? code
process.exitCode = finalCode
// A signal from now on means "stop waiting" for something a test left open.
signals.afterRun()

// `--forceExit`: end now, as Jest does, once what the run printed has been written. Otherwise the
// event loop ends the process: a pool has stopped its workers, but an inline one shares this process
// and a leaked handle keeps it alive, as with Jest's `--runInBand`.
if (forceExit) {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)])
  process.exit(finalCode)
}
