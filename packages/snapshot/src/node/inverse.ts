import { basename, dirname, join } from 'node:path'

/**
 * The test file a `.snap` file at the default location belongs to: the inverse of
 * `defaultSnapshotPath`, `<dir>/<dirName>/<file><extension>` back to `<dir>/<file>`. It is
 * `undefined` for a path that isn't one (wrong extension, or not inside a `dirName` directory).
 * A project with its own snapshot path resolver has no inverse here: the coordinator asks the
 * resolver the other way round (B23c Phase 4; B23d B1 extends this).
 * @public
 */
export function testPathOfSnapshot(
  snapshotPath: string,
  layout: { readonly dirName: string; readonly extension: string },
): string | undefined {
  const name = basename(snapshotPath)
  const directory = dirname(snapshotPath)
  if (!name.endsWith(layout.extension) || name.length === layout.extension.length) return undefined
  if (basename(directory) !== layout.dirName) return undefined
  return join(dirname(directory), name.slice(0, name.length - layout.extension.length))
}
