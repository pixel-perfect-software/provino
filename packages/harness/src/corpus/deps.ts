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
