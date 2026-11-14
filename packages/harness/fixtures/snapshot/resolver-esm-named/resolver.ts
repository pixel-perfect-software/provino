// A complete resolver, as an ES module with named exports and no default export: Jest reads
// `.default` of what it requires, so it never sees these.
import * as path from 'node:path'

export const resolveSnapshotPath = (testPath: string, extension: string): string =>
  path.join(path.dirname(testPath), '__snaps__', `${path.basename(testPath)}${extension}`)

export const resolveTestPath = (snapshotPath: string, extension: string): string =>
  path.join(path.dirname(snapshotPath), '..', path.basename(snapshotPath, extension))

export const testPathForConsistencyCheck = 'some/example.test.js'
