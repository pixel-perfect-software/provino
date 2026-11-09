import type { SnapshotUpdateMode } from '@provino/snapshot'
import type { SnapshotPolicy } from '@provino/types'

/**
 * What decides a run's update mode.
 * @public
 */
export interface UpdateModeInput {
  /** `-u`: the user asked for snapshots to be rewritten. */
  readonly update: boolean
  /** Whether this is a CI run (`--ci`, or the `CI` variable). */
  readonly ci: boolean
  /** The environment, for the variable the policy names. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly policy: Pick<SnapshotPolicy, 'ciUpdate' | 'updateEnvVar'>
}

const isMode = (value: string | undefined): value is SnapshotUpdateMode =>
  value === 'all' || value === 'new' || value === 'none'

/**
 * The mode a run treats snapshots with. `-u` rewrites. The policy's variable (Vitest's
 * `UPDATE_SNAPSHOT`) names a mode, or any other value means `all`. With neither, CI gets the
 * policy's `ciUpdate` (`none`, in both dialects) and a local run `new`.
 *
 * Jest: `ci && !update ? 'none' : update ? 'all' : 'new'` (jest-config `normalize.ts`). Vitest:
 * `resolveConfig.ts` L661-L672.
 * @public
 */
export function resolveUpdateMode(input: UpdateModeInput): SnapshotUpdateMode {
  const { update, ci, env, policy } = input
  if (update) return 'all'
  const fromEnv = policy.updateEnvVar === null ? undefined : env[policy.updateEnvVar]
  if (isMode(fromEnv)) return fromEnv
  if (fromEnv !== undefined && fromEnv !== '') return 'all'
  return ci ? policy.ciUpdate : 'new'
}
