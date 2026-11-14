// A resolver that keeps a test file's snapshots in `__snaps__/` beside it, as an ES module with a
// default export.
import * as path from 'node:path'

export default {
  resolveSnapshotPath: (testPath: string, extension: string): string =>
    path.join(path.dirname(testPath), '__snaps__', `${path.basename(testPath)}${extension}`),
  resolveTestPath: (snapshotPath: string, extension: string): string =>
    path.join(path.dirname(snapshotPath), '..', path.basename(snapshotPath, extension)),
  testPathForConsistencyCheck: 'some/example.test.js',
}
