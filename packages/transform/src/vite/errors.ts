/**
 * Error codes the Vite plugin host throws (T3.9).
 * @public
 */
export type ViteHostErrorCode = 'VITE_HOOK_UNSUPPORTED' | 'VITE_PLUGIN_FAILED'

/**
 * A Vite host error with a stable code. `plugin` names the plugin whose hook or context call
 * caused it.
 * @public
 */
export class ViteHostError extends Error {
  readonly code: ViteHostErrorCode
  readonly plugin: string

  constructor(code: ViteHostErrorCode, plugin: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ViteHostError'
    this.code = code
    this.plugin = plugin
  }
}
