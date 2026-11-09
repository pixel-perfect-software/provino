// Runs one timer-corpus file in a child process (`child.ts`) and reads back the `CoreRun`. The
// child fakes its own global timers, so the harness's test process never does.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureProfile } from '../fixture.ts'
import { runChildJson } from '../internal/child-json.ts'
import type { CoreRun } from '../runtime-corpus/run-core.ts'

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url))

/**
 * Runs `file` (absolute) under `profile` in a child node process. `nodeFlags` go before the script
 * (the Temporal fixture needs `--harmony-temporal`). Rejects with the child's output when it fails.
 */
export function runTimerChild(
  file: string,
  rootDir: string,
  profile: FixtureProfile,
  nodeFlags: readonly string[] = [],
): Promise<CoreRun> {
  return runChildJson<CoreRun>(
    CHILD,
    [file, rootDir, profile],
    rootDir,
    nodeFlags,
    `${path.basename(file)} (${profile})`,
  )
}
