/**
 * Stable codes for policy errors, so callers and tests assert on the code, not the text.
 * @public
 */
export type PolicyErrorCode =
  | 'POLICY_UNKNOWN_KEY'
  | 'POLICY_INVALID_LAYER'
  | 'POLICY_CLOSURE_NOT_SERIALIZABLE'
  | 'POLICY_BEHAVIOUR_LOAD_FAILED'
  | 'POLICY_BEHAVIOUR_NOT_FUNCTION'

/**
 * An error from `@provino/policy`. `path` is the policy key it concerns (`core.hookOrder`), when
 * there is one.
 * @public
 */
export class PolicyError extends Error {
  override readonly name = 'PolicyError'
  readonly code: PolicyErrorCode
  readonly path: string | undefined

  constructor(
    code: PolicyErrorCode,
    message: string,
    options?: { readonly path?: string; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.path = options?.path
  }
}
