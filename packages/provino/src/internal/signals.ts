// SIGINT, SIGTERM and SIGHUP, for the bin (T9.10). Library code never calls `process.exit` and never
// installs a handler (`run()` is re-entrant): the bin does, and gives the run two signals.
//
// - The first SIGINT aborts the run's `signal` with the reason `'SIGINT'`: no file starts, the
//   workers running files are killed, the others are stopped, and the run ends `interrupted`
//   (exit code 130). The first SIGTERM does the same with the reason `'SIGTERM'` and ends it
//   `terminated` (143). SIGHUP (the terminal went away, or `kill -HUP`) is handled like SIGTERM,
//   with the reason `'SIGHUP'`, and ends the bin with 129 (128 plus 1, as the harness's
//   `exitOnSignals` does): without a handler Node's default action would end the bin at once and
//   leave a worker that is in a synchronous loop running. The run's summary calls it
//   `interrupted`, since the orchestrator knows only SIGTERM by name; the bin's exit code is the
//   signal's.
// - Any further signal of the three aborts the `forceSignal`: every worker is killed at once, one
//   that is stopping slowly included, so the run ends without waiting for a teardown. The exit
//   code is still the first signal's.
//
// What a signal that comes before the run has anything to stop does is the same: it is one.

/** What the bin's `exitCode` for a signal is: 128 plus its number. */
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const

/** The signals the bin handles. */
export type HandledSignal = keyof typeof EXIT_CODES

/**
 * Where the handlers go: the process, or a stand-in in a test.
 * @internal
 */
export interface SignalTarget {
  on(event: HandledSignal, listener: () => void): unknown
  off(event: HandledSignal, listener: () => void): unknown
}

/**
 * The run's two signals, and how to stop listening.
 * @internal
 */
export interface SignalControl {
  /** Aborted by the first SIGINT, SIGTERM or SIGHUP, with that signal's name as the reason. */
  readonly signal: AbortSignal
  /** Aborted by the second signal of either kind. */
  readonly forceSignal: AbortSignal
  /** The exit code of the first signal that came (130, 143, 129), or `undefined` when none has. */
  exitCode(): number | undefined
  /** Stops listening, so a later signal takes the default action. */
  dispose(): void
}

/**
 * Listens for SIGINT, SIGTERM and SIGHUP and turns them into the two signals above. `onFirst` runs
 * once, as the first signal lands, with the exit code the process is to end with (the bin sets
 * `process.exitCode` there: a run that has nothing left to hold the event loop open would
 * otherwise end the process with Node's own code for an unsettled `await`, 13). `onForce` runs
 * once, when the force signal is aborted (the bin starts its exit deadline there).
 * @internal
 */
export function handleSignals(
  target: SignalTarget = process,
  options: {
    readonly onFirst?: (exitCode: number) => void
    readonly onForce?: () => void
  } = {},
): SignalControl {
  const cancel = new AbortController()
  const force = new AbortController()
  let first: HandledSignal | undefined
  const heard = (name: HandledSignal): void => {
    if (first === undefined) {
      first = name
      options.onFirst?.(EXIT_CODES[name])
      cancel.abort(name)
    } else if (!force.signal.aborted) {
      force.abort(name)
      options.onForce?.()
    }
  }
  const onInt = (): void => heard('SIGINT')
  const onTerm = (): void => heard('SIGTERM')
  const onHup = (): void => heard('SIGHUP')
  target.on('SIGINT', onInt)
  target.on('SIGTERM', onTerm)
  target.on('SIGHUP', onHup)
  return {
    signal: cancel.signal,
    forceSignal: force.signal,
    exitCode: () => (first === undefined ? undefined : EXIT_CODES[first]),
    dispose() {
      target.off('SIGINT', onInt)
      target.off('SIGTERM', onTerm)
      target.off('SIGHUP', onHup)
    },
  }
}
