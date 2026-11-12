// What the corpus modules need from the machine, so a test can replace it: no network, no real
// runner, no sandbox. The default is `runProcess`, which already runs a command in its own process
// group with a deadline.
import { type ProcessOptions, type ProcessResult, runProcess } from '../run-process.ts'

/**
 * Runs one command to its end.
 * @public
 */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>

/**
 * The corpus code's one seam to the outside world.
 * @public
 */
export interface CorpusDeps {
  readonly run: RunCommand
}

/**
 * The real thing.
 * @public
 */
export const defaultDeps: CorpusDeps = { run: runProcess }

/**
 * How a finished command ended, for an error message: `timed out`, `exited 1`, or `exited
 * SIGKILL` when a signal ended it.
 * @internal
 */
export function exitText(result: Pick<ProcessResult, 'exitCode' | 'signal' | 'timedOut'>): string {
  return result.timedOut ? 'timed out' : `exited ${result.exitCode ?? result.signal ?? 'by signal'}`
}

/**
 * The last `chars` characters of a command's output, trimmed, for an error message.
 * @internal
 */
export function tailOf(result: Pick<ProcessResult, 'output'>, chars: number): string {
  return result.output.trim().slice(-chars)
}
