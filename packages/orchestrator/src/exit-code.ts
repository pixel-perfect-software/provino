// Track 9 §Lifecycle and L476: the process exit codes. The failure, no-tests and unhandled codes
// are the dialect's (`orchestrator.exitCodes`; Jest and Vitest both use 1); the rest are fixed.
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
  Sigint: 130,
  Sigterm: 143,
} as const

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
 * 1. an interrupted run: `ExitCode.Sigint` (the summary doesn't say which signal; SIGTERM
 *    handling is T9.10's);
 * 2. no files ran, and `passWithNoTests` is off: `exitCodes.noTests`;
 * 3. a file failed: `exitCodes.failure`;
 * 4. an unhandled error, when the policy's `unhandledErrors` is `fail-run`: `exitCodes.unhandled`;
 * 5. a reporter failed: `exitCodes.failure`;
 * 6. otherwise `ExitCode.Pass`.
 * @public
 */
export function exitCodeFor(summary: RunSummary, options: ExitCodeOptions): number {
  const { orchestrator } = options.policy
  if (summary.reason === 'interrupted') return ExitCode.Sigint
  const passWithNoTests = options.passWithNoTests ?? orchestrator.passWithNoTests
  if (summary.files.length === 0 && !passWithNoTests) return orchestrator.exitCodes.noTests
  if (summary.files.some((file) => file.state === 'fail')) return orchestrator.exitCodes.failure
  if (orchestrator.unhandledErrors === 'fail-run' && summary.unhandled.length > 0) {
    return orchestrator.exitCodes.unhandled
  }
  if ((options.reporterFailures?.length ?? 0) > 0) return orchestrator.exitCodes.failure
  return ExitCode.Pass
}
