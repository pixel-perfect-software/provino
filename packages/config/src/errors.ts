/**
 * Stable codes for config errors, so callers and tests assert on the code, not the text.
 *
 * - `CONFIG_LOAD_FAILED`: the file couldn't be imported, its function threw, or a dialect's
 *   `detect` or a policy behaviour couldn't run. `cause` is the underlying error.
 * - `CONFIG_INVALID`: the file's default export, or a key in it, has the wrong shape or value.
 * - `CONFIG_UNKNOWN_DIALECT`: `dialect` names a dialect that isn't known.
 * - `CONFIG_DIALECT_TIE`: several dialects tie for the best `detect` score.
 * - `CONFIG_UNKNOWN_ENVIRONMENT`: the environment has no entry in the table the caller gave.
 * - `CONFIG_UNSUPPORTED`: a key that isn't wired yet (`projects`, `plugins`, `alsoServe`).
 * - `CONFIG_BAD_DIALECT_OPTIONS`: the dialect's options failed its schema, or its policy factory threw.
 * @public
 */
export type ConfigErrorCode =
  | 'CONFIG_LOAD_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_UNKNOWN_DIALECT'
  | 'CONFIG_DIALECT_TIE'
  | 'CONFIG_UNKNOWN_ENVIRONMENT'
  | 'CONFIG_UNSUPPORTED'
  | 'CONFIG_BAD_DIALECT_OPTIONS'

/**
 * One problem a dialect's options schema reported: where it is (`a.b.0`, empty for the options
 * as a whole) and what is wrong.
 * @public
 */
export interface ConfigIssue {
  readonly path: string
  readonly message: string
}

/**
 * A config error with a stable code. `issues` is set for `CONFIG_BAD_DIALECT_OPTIONS` when the
 * dialect's schema rejected the options; `cause` holds the underlying error where there is one.
 * @public
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  readonly code: ConfigErrorCode
  readonly issues: readonly ConfigIssue[]

  constructor(
    code: ConfigErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly issues?: readonly ConfigIssue[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.issues = options?.issues ?? []
  }
}
