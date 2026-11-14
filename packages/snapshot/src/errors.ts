/**
 * What a `SnapshotError` carries in `code`.
 * @public
 */
export type SnapshotErrorCode =
  /** A snapshot matcher ran and the policy names no printer. */
  | 'SNAPSHOT_NO_PRINTER'
  /** An inline snapshot must be written and its call's stack has no frame to put it at. */
  | 'SNAPSHOT_NO_INLINE_FRAME'
  /** A project names its own snapshot resolver and the policy has no `resolverFactory`. */
  | 'SNAPSHOT_NO_RESOLVER'
  /** A `.snap` file's header isn't the dialect's and the run may not rewrite it. */
  | 'SNAPSHOT_HEADER_MISMATCH'
  /** A snapshot matcher ran with no snapshot state (outside a test file's run). */
  | 'SNAPSHOT_NOT_INITIALIZED'
  /** An inline snapshot would have to be written: the writer is T7.11's. */
  | 'SNAPSHOT_INLINE_NOT_BUILT'
  /** A snapshot's key doesn't end in a number. */
  | 'SNAPSHOT_BAD_KEY'
  /** A serializer isn't a pretty-format plugin. */
  | 'SNAPSHOT_BAD_SERIALIZER'

/**
 * An error from the snapshot engine. Tests assert on `code`, not on the text.
 * @public
 */
export class SnapshotError extends Error {
  override readonly name = 'SnapshotError'
  readonly code: SnapshotErrorCode

  constructor(code: SnapshotErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
