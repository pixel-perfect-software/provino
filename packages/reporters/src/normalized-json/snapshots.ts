import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { NormalizedRun, SnapshotRunSummary } from '@provino/types'
import { posixRelative } from '../internal/posix-relative.ts'

/**
 * A run's snapshots as the normalized run has them: Jest's totals, and each `.snap` file the run
 * left on disk with the hash of its bytes (Track 12 R2's byte parity), its path POSIX and
 * relative to the project root. A file that can't be read is left out.
 * @internal
 */
export async function normalizeSnapshots(
  summary: SnapshotRunSummary,
  root: string,
): Promise<NonNullable<NormalizedRun['snapshots']>> {
  const files = (
    await Promise.all(
      summary.files.map(async (path) => {
        try {
          const bytes = await readFile(path)
          return {
            file: posixRelative(root, path),
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }
        } catch {
          return undefined
        }
      }),
    )
  ).flatMap((entry) => entry ?? [])
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { counters: summary.counters, files }
}
