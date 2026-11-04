import type { SerializedError } from '@provino/types'

/**
 * Error codes `@provino/rpc` uses. A caller sees `RPC_CLOSED` (the link went away, `cause` is why)
 * and `RPC_REMOTE_ERROR` (the method threw, `remote` is what); `RPC_UNKNOWN_METHOD` and
 * `RPC_UNCLONABLE` reach the caller as the `remote` error's `code`, or as the rejection's code when
 * the caller's own arguments can't be sent.
 * @public
 */
export type RpcErrorCode =
  | 'RPC_CLOSED'
  | 'RPC_REMOTE_ERROR'
  | 'RPC_UNKNOWN_METHOD'
  | 'RPC_UNCLONABLE'

/**
 * Options for an `RpcError`: `cause` as for any error, plus the remote error it reports.
 * @public
 */
export interface RpcErrorOptions extends ErrorOptions {
  readonly remote?: SerializedError
}

/**
 * An RPC failure with a stable code.
 * @public
 */
export class RpcError extends Error {
  readonly code: RpcErrorCode
  /** For `RPC_REMOTE_ERROR`: the error the remote method threw, as it crossed the link. */
  readonly remote?: SerializedError

  constructor(code: RpcErrorCode, message: string, options: RpcErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.name = 'RpcError'
    this.code = code
    if (options.remote !== undefined) this.remote = options.remote
  }
}
