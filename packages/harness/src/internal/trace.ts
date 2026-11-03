// The step trace a fixture writes through the global `trace(step)` (see `runner-config.ts`): one
// step per line in a file the recorder names, read after the run.
import { HarnessError } from '../errors.ts'
import { readIfExists } from './guards.ts'

/**
 * The steps in a trace file's text, one per line. The newline that ends the last step is not a
 * step; an empty line in the middle is (`trace('')`).
 * @internal
 */
export function parseTrace(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The steps a run traced, or none if the file was never written (nothing called `trace`).
 * @internal
 */
export async function readTrace(file: string): Promise<string[]> {
  const text = await readIfExists(file)
  return text === undefined ? [] : parseTrace(text)
}

/**
 * A trace is one file's steps in call order. With two or more test files they run in parallel and
 * their lines interleave, so a fixture that traces must have exactly one test file for the runner.
 * Throws `HARNESS_TRACE_MULTIPLE_FILES` otherwise; a run that traced nothing is not checked.
 * @internal
 */
export function assertTraceFromOneFile(
  trace: readonly string[],
  testFiles: readonly string[],
  label: string,
): void {
  if (trace.length === 0 || testFiles.length <= 1) return
  throw new HarnessError(
    'HARNESS_TRACE_MULTIPLE_FILES',
    `${label} traced ${trace.length} ${trace.length === 1 ? 'step' : 'steps'} but has ${testFiles.length} test files (${testFiles.join(', ')}); parallel files would interleave their lines, so a fixture that traces needs exactly one test file per runner`,
  )
}
