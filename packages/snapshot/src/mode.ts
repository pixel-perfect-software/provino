/**
 * How a run treats snapshots: `all` rewrites any that differ (`-u`), `new` writes the ones that
 * don't exist yet, `none` writes nothing and fails a missing one (CI). It is what
 * `FileJob.updateSnapshots` carries.
 * @public
 */
export type SnapshotUpdateMode = 'all' | 'new' | 'none'
