// The identity of a source file's text as a worker loaded it (B28 Phase 7): an inline snapshot's
// edit carries it (`InlineSnapshotEdit.sourceHash`), so the coordinator writes the edit only into the
// text its line and column were taken from. Both sides hash with this one function.
import { createHash } from 'node:crypto'

/**
 * A hash of `text`, compared for equality only.
 * @public
 */
export function inlineSourceHash(text: string): string {
  return createHash('sha1').update(text).digest('base64url')
}
