const path = require('node:path')

module.exports = {
  resolveSnapshotPath: (testPath: string, extension: string): string =>
    path.join(path.dirname(testPath), '__snapshots__', `${path.basename(testPath)}${extension}`),
  resolveTestPath: (snapshotPath: string): string => snapshotPath,
  testPathForConsistencyCheck: 'some/example.test.js',
}
