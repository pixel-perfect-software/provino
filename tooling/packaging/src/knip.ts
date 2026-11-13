import { binScript, runCommandAsync } from './exec.ts'

/** What knip said. */
export interface KnipResult {
  readonly ok: boolean
  readonly output: string
}

/**
 * Runs knip with the root `knip.ts`. Unused files, dependencies, unlisted dependencies and
 * unresolved imports are errors, so a non-zero exit fails hygiene. Unused exports and types are
 * warnings in the config and don't change the exit code. It runs beside other work.
 * @internal
 */
export async function runKnip(root: string): Promise<KnipResult> {
  const result = await runCommandAsync(
    process.execPath,
    [binScript('knip', 'knip'), '--no-progress'],
    { cwd: root, timeoutMs: 600_000 },
  )
  return { ok: result.status === 0, output: result.output }
}
