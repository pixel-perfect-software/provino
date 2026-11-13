#!/usr/bin/env node
import { missingBindingMessage } from './internal/native-binding.ts'
import { quickAnswer } from './internal/quick.ts'

// How long the process gets to end by itself once a second signal has killed the workers. This bin is
// the one place that calls `process.exit`: library code never does (T9.10).
const FORCE_GRACE_MS = 750

/** Waits until what was written to `stream` has been handed to the operating system. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve())
  })
}

// `--version` and `--help` need nothing a run needs, so they answer before the rest is imported:
// the rest includes the Oxc native bindings, which a machine may lack (T10.3).
const argv = process.argv.slice(2)
const quick = quickAnswer(argv)
if (quick !== undefined) {
  process.stdout.write(quick)
} else {
  let loaded:
    | [typeof import('./internal/cli.ts'), typeof import('./internal/signals.ts')]
    | undefined
  try {
    loaded = await Promise.all([import('./internal/cli.ts'), import('./internal/signals.ts')])
  } catch (error) {
    // An Oxc binding that didn't load fails the import, before `main` runs: one message, no stack.
    const message = missingBindingMessage(error)
    if (message === undefined) throw error
    process.stderr.write(message)
    process.exitCode = 1
  }
  if (loaded !== undefined) {
    const [{ main }, { handleSignals }] = loaded
    const signals = handleSignals(process, {
      // Set as the signal lands, not once `main` returns: a run left with nothing to hold the event
      // loop open (a reporter that never settles) would otherwise end on the unsettled `await` below
      // with Node's 13.
      onFirst: (exitCode) => {
        process.exitCode = exitCode
      },
      onForce: () => {
        setTimeout(() => process.exit(signals.exitCode() ?? 1), FORCE_GRACE_MS).unref()
      },
    })

    let forceExit = false
    const code = await main(argv, {
      signal: signals.signal,
      forceSignal: signals.forceSignal,
      onForceExit: () => {
        forceExit = true
      },
    })
    // A signal that came ends the process with its code even when there was nothing left to
    // interrupt (a Ctrl+C while the workers were still stopping, or during `--listTests`).
    const finalCode = signals.exitCode() ?? code
    process.exitCode = finalCode
    // A signal from now on means "stop waiting" for something a test left open.
    signals.afterRun()

    // `--forceExit`: end now, as Jest does, once what the run printed has been written. Otherwise the
    // event loop ends the process: a pool has stopped its workers, but an inline one shares this
    // process and a leaked handle keeps it alive, as with Jest's `--runInBand`.
    if (forceExit) {
      await Promise.all([flushed(process.stdout), flushed(process.stderr)])
      process.exit(finalCode)
    }
  }
}
