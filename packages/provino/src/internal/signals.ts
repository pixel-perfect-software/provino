// The bin's signal handling (T9.10). Library code never installs a handler or calls `process.exit`
// (`run()` is re-entrant); the bin does. The signals are the orchestrator's `RUN_SIGNALS`, each
// with its exit code: the first one aborts the run's `signal` with its name as the reason, any
// further one aborts the `forceSignal` and keeps the first's exit code.
import { RUN_SIGNALS, type RunSignal } from '@provino/orchestrator'

/** The signals the bin handles. */
export type HandledSignal = RunSignal

const NAMES = Object.keys(RUN_SIGNALS) as readonly HandledSignal[]

/**
 * Where the handlers go: the process, or a stand-in in a test.
 * @internal
 */
export interface SignalTarget {
  on(event: HandledSignal, listener: () => void): unknown
  once(event: HandledSignal, listener: () => void): unknown
  off(event: HandledSignal, listener: () => void): unknown
}

/**
 * The run's two signals, and how to stop listening.
 * @internal
 */
export interface SignalControl {
  /** Aborted by the first signal, with its name as the reason. */
  readonly signal: AbortSignal
  /** Aborted by the second signal of any kind. */
  readonly forceSignal: AbortSignal
  /** The exit code of the first signal that came, or `undefined` when none has. */
  exitCode(): number | undefined
  /** Stops listening, so a later signal takes the default action. */
  dispose(): void
  /**
   * The run is over: stops listening as `dispose` does, and a signal that comes now ends the
   * process at once with its own exit code (`exit`), not by the signal. A leaked handle can keep an
   * inline pool's process alive, and a signal then means "stop waiting".
   */
  afterRun(): void
}

/**
 * Listens for every signal of `RUN_SIGNALS` and turns them into the two signals above. `onFirst`
 * runs once, as the first signal lands, with the exit code the process is to end with (the bin sets
 * `process.exitCode` there: a run with nothing left to hold the event loop open would otherwise
 * end the process with Node's own code for an unsettled `await`, 13). `onForce` runs once, when the
 * force signal is aborted (the bin starts its exit deadline there).
 * @internal
 */
export function handleSignals(
  target: SignalTarget = process,
  options: {
    readonly onFirst?: (exitCode: number) => void
    readonly onForce?: () => void
    /** Ends the process: `afterRun`'s handlers call it. Default `process.exit`. */
    readonly exit?: (exitCode: number) => void
  } = {},
): SignalControl {
  const cancel = new AbortController()
  const force = new AbortController()
  let first: HandledSignal | undefined
  const heard = (name: HandledSignal): void => {
    if (first === undefined) {
      first = name
      options.onFirst?.(RUN_SIGNALS[name].exitCode)
      cancel.abort(name)
    } else if (!force.signal.aborted) {
      force.abort(name)
      options.onForce?.()
    }
  }
  const listeners = NAMES.map((name) => [name, () => heard(name)] as const)
  for (const [name, listener] of listeners) target.on(name, listener)
  const dispose = (): void => {
    for (const [name, listener] of listeners) target.off(name, listener)
  }
  return {
    signal: cancel.signal,
    forceSignal: force.signal,
    exitCode: () => (first === undefined ? undefined : RUN_SIGNALS[first].exitCode),
    dispose,
    afterRun() {
      dispose()
      const exit = options.exit ?? ((code: number) => process.exit(code))
      for (const name of NAMES) target.once(name, () => exit(RUN_SIGNALS[name].exitCode))
    },
  }
}
