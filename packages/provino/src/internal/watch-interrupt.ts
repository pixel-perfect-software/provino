// An interrupt key at a watch run's start (B23c Phase 8). In Jest the `TestWatcher` exists before a
// run starts, so a key then still cuts it short. Here the run's controller is made inside
// `session.run`, after the host has selected the files, so a key before that would find nothing to
// abort: the host's run keeps it and the session's `run` takes it the moment it creates the
// controller. A key after the host's run is over is swallowed, as Jest's is while `isRunning` is
// still set.
import type { WatchSession } from '@provino/orchestrator'

/**
 * What the host's run and interrupt call, and the session to hand `executeProject`.
 * @internal
 */
export interface RunInterrupts {
  /** The session whose `run` applies an interrupt that came before it. */
  readonly session: WatchSession
  /** The host's run starts: no interrupt is pending. */
  begin(): void
  /** The host's run is over: a later interrupt is dropped. */
  end(): void
  /** The driver's interrupt: aborts the session's run, or waits for it to start. */
  interrupt(): void
}

/**
 * Wraps `session` so an interrupt during a host run that has not reached `session.run` is applied
 * as it starts.
 * @internal
 */
export function latchInterrupts(session: WatchSession): RunInterrupts {
  let active = false
  let pending = false
  return {
    session: {
      get running() {
        return session.running
      },
      run(options) {
        // `run` creates its controller before its first await, so the interrupt reaches it.
        const summary = session.run(options)
        if (pending) {
          pending = false
          session.interrupt()
        }
        return summary
      },
      interrupt: () => session.interrupt(),
      onChange: (listener) => session.onChange(listener),
      close: () => session.close(),
    },
    begin() {
      active = true
      pending = false
    },
    end() {
      active = false
      pending = false
    },
    interrupt() {
      if (!active) return
      if (session.running) session.interrupt()
      else pending = true
    },
  }
}
