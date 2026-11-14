// A snapshot resolver that keeps a test file's snapshots in `__snaps__/` beside it, under the
// extension it is given (`.snap`), and its inverse.
const path = require('node:path')

module.exports = {
  resolveSnapshotPath: (testPath: string, extension: string): string =>
    path.join(path.dirname(testPath), '__snaps__', `${path.basename(testPath)}${extension}`),
  resolveTestPath: (snapshotPath: string, extension: string): string =>
    path.join(path.dirname(snapshotPath), '..', path.basename(snapshotPath, extension)),
  testPathForConsistencyCheck: 'some/example.test.js',
}
