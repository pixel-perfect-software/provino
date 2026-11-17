// The watch plugin error, in a module of its own with no imports: the bin names it in its error
// handler on every run, and the rest of watch mode loads only under `--watch` (the `watch` chunk of
// the `provino` bundle, B23f), so it can't live in `plugin-host.ts`.

/**
 * Why watch mode could not start with its plugins.
 *
 * - `JEST_WATCH_PLUGIN_LOAD`: a plugin's module failed to load, or its class to construct.
 * - `JEST_WATCH_PLUGIN_CONFLICT`: a plugin took a key Jest reserves, or one another plugin took.
 * - `JEST_WATCH_PLUGIN_HOOK`: a plugin's `onFileChange` listener threw (Jest's call is synchronous,
 *   so the throw ends the session: jest-cli prints its stack in red, exit 1).
 * @beta
 */
export type JestWatchPluginErrorCode =
  | 'JEST_WATCH_PLUGIN_LOAD'
  | 'JEST_WATCH_PLUGIN_CONFLICT'
  | 'JEST_WATCH_PLUGIN_HOOK'

/**
 * A watch plugin that could not be loaded or that conflicts. `message` is what jest-cli prints
 * for it (`run.ts` L30-L38: the error's `stack` in red, or the error itself where it has none),
 * and Jest exits 1.
 * @beta
 */
export class JestWatchPluginError extends Error {
  override readonly name = 'JestWatchPluginError'
  readonly code: JestWatchPluginErrorCode

  constructor(code: JestWatchPluginErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
