// SIGINT and SIGTERM, for the bin (T9.10). Library code never calls `process.exit` and never
// installs a handler (`run()` is re-entrant): the bin does, and gives the run two signals.
//
// - The first SIGINT aborts the run's `signal` with the reason `'SIGINT'`: no file starts, the
//   workers running files are killed, the others are stopped, and the run ends `interrupted`
//   (exit code 130). The first SIGTERM does the same with the reason `'SIGTERM'` and ends it
//   `terminated` (143).
// - Any further SIGINT or SIGTERM aborts the `forceSignal`: every worker is killed at once, one
//   that is stopping slowly included, so the run ends without waiting for a teardown. The exit
//   code is still the first signal's.
//
// What a signal that comes before the run has anything to stop does is the same: it is one.

/** What the bin's `exitCode` for a signal is: 128 plus its number. */
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const

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
  /** Aborted by the first SIGINT or SIGTERM, with that signal's name as the reason. */
  readonly signal: AbortSignal
  /** Aborted by the second signal of either kind. */
  readonly forceSignal: AbortSignal
  /** The exit code of the first signal that came (130, 143), or `undefined` when none has. */
  exitCode(): number | undefined
  /** Stops listening, so a later signal takes the default action. */
  dispose(): void
}

/**
 * Listens for SIGINT and SIGTERM and turns them into the two signals above. `onForce` runs once,
 * when the force signal is aborted (the bin starts its exit deadline there).
 * @internal
 */
export function handleSignals(
  target: SignalTarget = process,
  options: { readonly onForce?: () => void } = {},
): SignalControl {
  const cancel = new AbortController()
  const force = new AbortController()
  let first: HandledSignal | undefined
  const heard = (name: HandledSignal): void => {
    if (first === undefined) {
      first = name
      cancel.abort(name)
    } else if (!force.signal.aborted) {
      force.abort(name)
      options.onForce?.()
    }
  }
  const onInt = (): void => heard('SIGINT')
  const onTerm = (): void => heard('SIGTERM')
  target.on('SIGINT', onInt)
  target.on('SIGTERM', onTerm)
  return {
    signal: cancel.signal,
    forceSignal: force.signal,
    exitCode: () => (first === undefined ? undefined : EXIT_CODES[first]),
    dispose() {
      target.off('SIGINT', onInt)
      target.off('SIGTERM', onTerm)
    },
  }
}
