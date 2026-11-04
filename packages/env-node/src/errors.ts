/**
 * Stable codes for `@provino/env-node` errors, so callers and tests assert on the code, not the
 * text.
 * @public
 */
export type NodeEnvironmentErrorCode = 'ENV_NODE_REALM_UNSUPPORTED'

/**
 * An error from the Node environment. A global it cannot restore is not an error: `teardown`
 * reports those (decision D22).
 * @public
 */
export class NodeEnvironmentError extends Error {
  readonly code: NodeEnvironmentErrorCode

  constructor(code: NodeEnvironmentErrorCode, message: string) {
    super(message)
    this.name = 'NodeEnvironmentError'
    this.code = code
  }
}
