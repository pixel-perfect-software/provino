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
  /** The project's snapshot files no test file has, found after its files ran (sorted). */
  readonly removed: string[]
}

/** No snapshot activity: what a member with only obsolete files starts from. */
const EMPTY_COUNTERS: SnapshotRunSummary['counters'] = {
  added: 0,
  matched: 0,
  unmatched: 0,
  updated: 0,
  unchecked: 0,
  total: 0,
  filesAdded: 0,
  filesRemoved: 0,
  filesUnmatched: 0,
  filesUpdated: 0,
}

/**
 * A member's own summary: what its files reported, plus its obsolete snapshot files, which
 * `TestScheduler` adds to `filesRemoved` and `filesRemovedList` after the run (L203-L221).
 */
function memberSummary(member: SnapshotMember): SnapshotRunSummary | undefined {
  const reported = member.aggregate.summary(member.update)
  if (member.removed.length === 0) return reported
  const base = reported ?? {
    counters: EMPTY_COUNTERS,
    uncheckedKeysByFile: [],
    update: member.update,
    files: [],
  }
  return {
    ...base,
    counters: {
      ...base.counters,
      filesRemoved: base.counters.filesRemoved + member.removed.length,
    },
    filesRemovedList: [...(base.filesRemovedList ?? []), ...member.removed],
  }
}

/** A member with nothing reported yet. */
export function snapshotMember(
  update: SnapshotMember['update'],
  policy: SnapshotMember['policy'],
): SnapshotMember {
  return { aggregate: createSnapshotAggregate(), update, policy, removed: [] }
}

/** The members' summaries as one: counters added, unchecked keys and files joined. The update mode is the first reporting member's. */
export function mergedSnapshots(
  members: readonly SnapshotMember[],
): SnapshotRunSummary | undefined {
  const parts = members.flatMap((member) => memberSummary(member) ?? [])
  const [first] = parts
  if (first === undefined) return undefined
  const counters = { ...first.counters }
  for (const part of parts.slice(1)) {
    for (const name of Object.keys(counters) as (keyof typeof counters)[]) {
      counters[name] += part.counters[name]
    }
  }
  const removed = parts.flatMap((part) => part.filesRemovedList ?? [])
  return {
    counters,
    uncheckedKeysByFile: parts.flatMap((part) => part.uncheckedKeysByFile),
    update: first.update,
    files: [...new Set(parts.flatMap((part) => part.files))].sort(),
    ...(removed.length === 0 ? {} : { filesRemovedList: removed }),
  }
}

/** Whether any member's own rule fails the run on its snapshots. */
export function snapshotsFailRun(members: readonly SnapshotMember[]): boolean {
  return members.some((member) => snapshotRunFails(memberSummary(member), member.policy))
}
