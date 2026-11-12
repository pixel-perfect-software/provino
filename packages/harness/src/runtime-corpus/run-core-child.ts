// `runUnderCore` in a child process, for the fixtures whose errors come from timers and rejections.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureProfile } from '../fixture.ts'
import { runChildJson } from '../internal/child-json.ts'
import type { CoreRun } from './run-core.ts'

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url))

/** Whether a runtime-corpus fixture raises process-level errors, and so runs in a child. */
export function needsChild(fixtureId: string): boolean {
  return path.posix.basename(fixtureId).startsWith('errors-')
}

/** Runs `file` (absolute) under `profile` in a child node process. */
export function runUnderCoreInChild(
  file: string,
  rootDir: string,
  profile: FixtureProfile,
): Promise<CoreRun> {
  return runChildJson<CoreRun>(
    CHILD,
    [file, rootDir, profile],
    rootDir,
    [],
    `${path.basename(file)} (${profile})`,
  )
}
