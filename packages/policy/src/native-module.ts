import type { ModulePolicy } from '@provino/types'

/**
 * The native runtime's module settings: Provino's own values, which `@provino/config` layers for a
 * project with no dialect. The keys mean what `ModulePolicy` says; both dialects keep `assetImports`
 * `off`.
 *
 * - `assetImports`: an asset or style file is a module the loader makes, as Vite's dev server gives
 *   a Vite app's.
 * - `reevaluateHookingExternals`, `reevaluatePatchingExternals`: a package whose first load reads a
 *   file's globals or writes the global is evaluated per file, as under Jest: `@testing-library/dom`
 *   builds `screen` over `document.body` as it loads (D221, #233).
 * @public
 */
export const nativeModulePolicy: Pick<
  ModulePolicy,
  'assetImports' | 'reevaluateHookingExternals' | 'reevaluatePatchingExternals'
> = {
  assetImports: 'built-in',
  reevaluateHookingExternals: true,
  reevaluatePatchingExternals: true,
}
