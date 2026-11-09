// `runPolicyFile` in a child node process (see `child.ts` for why).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExpectTest } from '../expect-corpus/run-expect.ts'
import { runChildJson } from '../internal/child-json.ts'
import type { PolicyFlip, PolicyProfile } from './profiles.ts'

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url))

/** Runs `file` (absolute) under `profile`'s policy, from `rootDir`, in a child node process. */
export function runPolicyFileInChild(
  file: string,
  rootDir: string,
  profile: PolicyProfile,
  flip?: PolicyFlip,
): Promise<readonly ExpectTest[]> {
  return runChildJson<readonly ExpectTest[]>(
    CHILD,
    [file, rootDir, profile, flip ?? '-'],
    rootDir,
    [],
    `${path.basename(file)} (${profile}${flip === undefined ? '' : `, ${flip}`})`,
  )
}
