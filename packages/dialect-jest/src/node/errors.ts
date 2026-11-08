/**
 * Stable codes for errors reading a Jest config, so callers and tests assert on the code. The
 * message is Jest 30.5's own text wherever Jest has one (uncoloured), so a user sees what Jest
 * would print.
 *
 * - `JEST_CONFIG_NOT_FOUND`: no config and no `package.json` from the directory up to the root.
 * - `JEST_CONFIG_NO_ROOT`: an explicit path that doesn't exist.
 * - `JEST_CONFIG_MULTIPLE`: more than one config in one directory ("Multiple configurations found").
 * - `JEST_CONFIG_LOAD_FAILED`: the file couldn't be read or run, or its function threw (`cause`).
 * - `JEST_CONFIG_TS_LOADER`: a TypeScript config Node can't strip, and no loader to fall back to.
 * - `JEST_CONFIG_INVALID`: a key has the wrong type or value (Jest's `ValidationError`).
 * - `JEST_CONFIG_PRESET`: the preset can't be found or loaded.
 * - `JEST_CONFIG_MODULE_NOT_FOUND`: a module a key names can't be resolved.
 * - `JEST_CONFIG_DUPLICATE_PROJECT`: two `projects` resolve to the same config file.
 * @public
 */
export type JestConfigErrorCode =
  | 'JEST_CONFIG_NOT_FOUND'
  | 'JEST_CONFIG_NO_ROOT'
  | 'JEST_CONFIG_MULTIPLE'
  | 'JEST_CONFIG_LOAD_FAILED'
  | 'JEST_CONFIG_TS_LOADER'
  | 'JEST_CONFIG_INVALID'
  | 'JEST_CONFIG_PRESET'
  | 'JEST_CONFIG_MODULE_NOT_FOUND'
  | 'JEST_CONFIG_DUPLICATE_PROJECT'

/**
 * An error reading a Jest config, with a stable code. `cause` holds the underlying error where
 * there is one.
 * @public
 */
export class JestConfigError extends Error {
  override readonly name = 'JestConfigError'
  readonly code: JestConfigErrorCode

  constructor(code: JestConfigErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

/** An error's message, or the text of whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
