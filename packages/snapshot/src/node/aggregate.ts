import type { SnapshotUpdateMode } from '@provino/snapshot'
import type {
  SnapshotCounters,
  SnapshotFileReport,
  SnapshotPolicy,
  SnapshotRunSummary,
} from '@provino/types'

/**
 * Adds up the files' snapshot reports the way Jest's `addResult` does: a file counts as added,
 * removed, unmatched or updated when it had any such snapshot, and the totals are plain sums.
 * @public
 */
export interface SnapshotAggregate {
  add(report: SnapshotFileReport, testFile: string): void
  /** The run's snapshots, or `undefined` when no file reported any. */
  summary(update: SnapshotUpdateMode): SnapshotRunSummary | undefined
}

/**
 * Starts an empty aggregate.
 * @public
 */
export function createSnapshotAggregate(): SnapshotAggregate {
  const counters = {
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
  const uncheckedKeysByFile: { file: string; keys: readonly string[] }[] = []
  const files = new Set<string>()
  let reports = 0

  return {
    add(report, testFile): void {
      reports++
      if (report.added > 0) counters.filesAdded++
      if (report.fileDeleted) counters.filesRemoved++
      if (report.unmatched > 0) counters.filesUnmatched++
      if (report.updated > 0) counters.filesUpdated++
      counters.added += report.added
      counters.matched += report.matched
      counters.unmatched += report.unmatched
      counters.updated += report.updated
      counters.unchecked += report.unchecked
      counters.total += report.added + report.updated + report.unmatched + report.matched
      if (report.uncheckedKeys.length > 0 && report.unchecked > 0) {
        uncheckedKeysByFile.push({ file: testFile, keys: report.uncheckedKeys })
      }
      if (report.file !== null) files.add(report.file)
    },
    summary(update): SnapshotRunSummary | undefined {
      if (reports === 0) return undefined
      const frozen: SnapshotCounters = { ...counters }
      return { counters: frozen, uncheckedKeysByFile, update, files: [...files].sort() }
    },
  }
}

/**
 * Whether a run's snapshots make it fail. A run that rewrites (`all`) never does. Otherwise an
 * obsolete snapshot, or an obsolete snapshot file, does when the policy says so for the mode:
 * `failCI` when nothing may be written (`none`, CI), `failLocal` when new snapshots are
 * (`new`). Jest: `true` for both (`snapshot.failure` in `TestScheduler`). Vitest: `false` and
 * `true` (it only checks under `none`, in the worker). A snapshot that didn't match is a failed
 * test already.
 * @public
 */
export function snapshotRunFails(
  summary: SnapshotRunSummary | undefined,
  policy: Pick<SnapshotPolicy, 'obsolete'>,
): boolean {
  if (summary === undefined || summary.update === 'all') return false
  const { unchecked, filesRemoved } = summary.counters
  if (unchecked === 0 && filesRemoved === 0) return false
  return summary.update === 'none' ? policy.obsolete.failCI : policy.obsolete.failLocal
}
