import { basename, dirname, join } from 'node:path'

/**
 * Where a test file's snapshots live by default: `__snapshots__/<file>.snap` beside it (the
 * policy's `dirName` and `extension`).
 * @public
 */
export function defaultSnapshotPath(
  testPath: string,
  layout: { readonly dirName: string; readonly extension: string },
): string {
  return join(dirname(testPath), layout.dirName, `${basename(testPath)}${layout.extension}`)
}
