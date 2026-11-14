// Track 9 §Lifecycle and L476: the process exit codes. The failure, no-tests and unhandled codes
// are the dialect's (`orchestrator.exitCodes`; Jest and Vitest both use 1); the rest are fixed.
import { snapshotRunFails } from '@provino/snapshot/node'
import type { Policy, RunSummary } from '@provino/types'

/**
 * The exit codes that don't depend on the dialect. A usage or config error is 2 (Jest uses 1; a
 * dialect front end may map it).
 * @public
 */
export const ExitCode = {
  Pass: 0,
  TestFailure: 1,
  UsageError: 2,
  /** 128 plus SIGHUP's number. */
  Sighup: 129,
  /** 128 plus SIGINT's number. */
  Sigint: 130,
  /** 128 plus SIGTERM's number. */
  Sigterm: 143,
} as const

/**
 * The signals that end a run, and what each means: how the run's summary says so (`reason`) and
 * the exit code of a process it ends. A run's `signal` is aborted with one of these names as the
 * reason (any other reason, or none, is SIGINT's), and the bin handles exactly these.
 * @public
 */
export const RUN_SIGNALS: {
  readonly SIGINT: { readonly reason: 'interrupted'; readonly exitCode: 130 }
  readonly SIGTERM: { readonly reason: 'terminated'; readonly exitCode: 143 }
  readonly SIGHUP: { readonly reason: 'hangup'; readonly exitCode: 129 }
} = {
  SIGINT: { reason: 'interrupted', exitCode: ExitCode.Sigint },
  SIGTERM: { reason: 'terminated', exitCode: ExitCode.Sigterm },
  SIGHUP: { reason: 'hangup', exitCode: ExitCode.Sighup },
}

/**
 * The name of a signal that ends a run.
 * @public
 */
export type RunSignal = keyof typeof RUN_SIGNALS

/**
 * Whether `value` is the name of a signal that ends a run: what an aborted `signal`'s reason says.
 * @public
 */
export function isRunSignal(value: unknown): value is RunSignal {
  return typeof value === 'string' && Object.hasOwn(RUN_SIGNALS, value)
}

/**
 * What `exitCodeFor` reads besides the summary.
 * @public
 */
export interface ExitCodeOptions {
  /** The project's resolved policy: `orchestrator.exitCodes`, `unhandledErrors`, `passWithNoTests`. */
  readonly policy: Policy
  /** Overrides `policy.orchestrator.passWithNoTests` (Jest's `--passWithNoTests`). */
  readonly passWithNoTests?: boolean
  /** What the reporters failed with (`ReporterBusHandle.failures()`). */
  readonly reporterFailures?: readonly unknown[]
}

/**
 * The exit code of a finished run, the first of these that applies:
 *
 * 1. a run a signal ended (`RUN_SIGNALS`): interrupted, `ExitCode.Sigint` (130); terminated,
 *    `ExitCode.Sigterm` (143); hung up, `ExitCode.Sighup` (129);
 * 2. no files ran, and `passWithNoTests` is off: `exitCodes.noTests`;
 * 3. a file failed: `exitCodes.failure`;
 * 4. the run's snapshots fail it: obsolete snapshots that the policy's `snapshot.obsolete` says
 *    fail the run in this update mode (Jest: `snapshot.failure`): `exitCodes.failure`;
 * 5. the run's coverage missed a threshold: `exitCodes.failure`;
 * 6. an unhandled error, when the policy's `unhandledErrors` is `fail-run`: `exitCodes.unhandled`;
 * 7. a reporter failed: `exitCodes.failure`;
 * 8. otherwise `ExitCode.Pass`.
 * @public
 */
export function exitCodeFor(summary: RunSummary, options: ExitCodeOptions): number {
  const { orchestrator } = options.policy
  for (const { reason, exitCode } of Object.values(RUN_SIGNALS)) {
    if (summary.reason === reason) return exitCode
  }
  const passWithNoTests = options.passWithNoTests ?? orchestrator.passWithNoTests
  if (summary.files.length === 0 && !passWithNoTests) return orchestrator.exitCodes.noTests
  if (summary.files.some((file) => file.state === 'fail')) return orchestrator.exitCodes.failure
  if (summary.snapshotsFail ?? snapshotRunFails(summary.snapshots, options.policy.snapshot)) {
    return orchestrator.exitCodes.failure
  }
  if ((summary.coverage?.thresholdFailures.length ?? 0) > 0) return orchestrator.exitCodes.failure
  if (orchestrator.unhandledErrors === 'fail-run' && summary.unhandled.length > 0) {
    return orchestrator.exitCodes.unhandled
  }
  if ((options.reporterFailures?.length ?? 0) > 0) return orchestrator.exitCodes.failure
  return ExitCode.Pass
}
