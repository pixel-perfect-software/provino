// A run over several projects judges each project's snapshots by that project's own policy and
// update mode, and shows one merged summary.
import {
  createSnapshotAggregate,
  type resolveUpdateMode,
  type SnapshotAggregate,
  snapshotRunFails,
} from '@provino/snapshot/node'
import type { Policy, SnapshotRunSummary } from '@provino/types'

/** One project's snapshots: what its files reported, its update mode and its policy. */
export interface SnapshotMember {
  readonly aggregate: SnapshotAggregate
  readonly update: ReturnType<typeof resolveUpdateMode>
  readonly policy: Pick<Policy['snapshot'], 'obsolete'>
}

/** A member with nothing reported yet. */
export function snapshotMember(
  update: SnapshotMember['update'],
  policy: SnapshotMember['policy'],
): SnapshotMember {
  return { aggregate: createSnapshotAggregate(), update, policy }
}

/** The members' summaries as one: counters added, unchecked keys and files joined. The update mode is the first reporting member's. */
export function mergedSnapshots(
  members: readonly SnapshotMember[],
): SnapshotRunSummary | undefined {
  const parts = members.flatMap((member) => member.aggregate.summary(member.update) ?? [])
  const [first] = parts
  if (first === undefined) return undefined
  const counters = { ...first.counters }
  for (const part of parts.slice(1)) {
    for (const name of Object.keys(counters) as (keyof typeof counters)[]) {
      counters[name] += part.counters[name]
    }
  }
  return {
    counters,
    uncheckedKeysByFile: parts.flatMap((part) => part.uncheckedKeysByFile),
    update: first.update,
    files: [...new Set(parts.flatMap((part) => part.files))].sort(),
  }
}

/** Whether any member's own rule fails the run on its snapshots. */
export function snapshotsFailRun(members: readonly SnapshotMember[]): boolean {
  return members.some((member) =>
    snapshotRunFails(member.aggregate.summary(member.update), member.policy),
  )
}
