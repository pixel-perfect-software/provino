// The script `watch-coordinator.ts` follows and what it writes back: shared by it and
// `watch-session.test.ts` (types only, so the test can import it without running the coordinator).
import type { FileFilter, IsolationTier } from '@provino/types'

/** One step of the script. Paths are relative to the project directory. */
export type Step =
  | {
      readonly do: 'run'
      readonly fileFilters?: readonly FileFilter[]
      /** A related-files selection over these paths. */
      readonly related?: readonly string[]
      /** Interrupt the run when the test of this name starts. */
      readonly interruptAt?: string
      /** Close the whole session when the test of this name starts. */
      readonly closeAt?: string
      /** Make the bus reject the first `<event> <path>` (`file:end a.test.js`). */
      readonly throwOn?: string
      /** Ask for a second run while this one goes, and note what that says. */
      readonly concurrent?: boolean
    }
  | { readonly do: 'write'; readonly path: string; readonly text: string }
  | { readonly do: 'unlink'; readonly path: string }
  | { readonly do: 'flush' }
  | { readonly do: 'close' }
  /** Feed a change and fire the window after the session is closed: no listener may hear it. */
  | { readonly do: 'change-after-close'; readonly path: string }

/** How the session is made. */
export interface SessionSetup {
  readonly isolation?: IsolationTier
  /** The policy's `orchestrator.unhandledErrors`. */
  readonly unhandledErrors?: 'fail-run' | 'ignore'
  /** An absolute path: the run's own global setup module (the neutral signature). */
  readonly globalSetup?: string
  /** A `file:` URL: the policy's `orchestrator.affected.extractor` module, export `extractor`. */
  readonly extractor?: string
  readonly maxWorkers?: number
  /** Add an `onChange` listener that throws, before the one that records the batches. */
  readonly throwingListener?: boolean
}

/** What one run reported. */
export interface RunReport {
  readonly reason: string
  /** Each file's state, by its path. */
  readonly files: Record<string, string>
  /** The worker that took each file. */
  readonly workers: Record<string, number>
  /** Each failed file's error messages. */
  readonly errors: Record<string, readonly string[]>
  /** The bus events of the run, in order: `run:start`, `file:end <path>`, `run:end`. */
  readonly events: readonly string[]
  /** How many unhandled errors the summary held. */
  readonly unhandled: number
  /** What the run threw, if it did. */
  readonly thrown?: { readonly code: unknown; readonly message: string }
  /** What a second run asked for while this one went threw. */
  readonly concurrent?: { readonly code: unknown }
}

/** What the coordinator writes. */
export interface Output {
  readonly reports: readonly RunReport[]
  readonly batches: readonly (readonly string[])[]
  /** The forked workers' noted pids still running right after `close()` resolved. */
  readonly aliveAfterClose: readonly number[]
  /** Batches a listener heard after the session was closed. */
  readonly heardAfterClose: number
  /** What the session wrote to its stderr. */
  readonly stderr: string
}
