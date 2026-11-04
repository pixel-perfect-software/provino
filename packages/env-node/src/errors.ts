/**
 * Stable codes for `@provino/env-node` errors, so callers and tests assert on the code, not the
 * text.
 * @public
 */
export type NodeEnvironmentErrorCode = 'ENV_NODE_RESTORE_FAILED' | 'ENV_NODE_REALM_UNSUPPORTED'

/**
 * A global property the environment could not put back: a property added during the file that
 * is not configurable (`delete`), or a changed one whose original descriptor can no longer be
 * defined (`redefine`).
 * @public
 */
export interface RestoreFailure {
  readonly key: string | symbol
  readonly action: 'delete' | 'redefine'
}

/**
 * An error from the Node environment. `failures` is set for `ENV_NODE_RESTORE_FAILED`. It holds
 * the keys themselves (a symbol cannot be cloned), so a worker reports the error to the
 * coordinator as a serialized error record that carries `code` and the message, not as this class.
 * @public
 */
export class NodeEnvironmentError extends Error {
  readonly code: NodeEnvironmentErrorCode
  readonly failures: readonly RestoreFailure[]

  constructor(
    code: NodeEnvironmentErrorCode,
    message: string,
    options?: { readonly failures?: readonly RestoreFailure[]; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NodeEnvironmentError'
    this.code = code
    this.failures = options?.failures ?? []
  }
}
