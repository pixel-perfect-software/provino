import type { ModulePolicy } from '@provino/types'

/**
 * The native runtime's module settings. Provino's own values, which `@provino/config` layers for a
 * project with no dialect:
 *
 * - `assetImports`: a project imports an asset or style file (`./logo.svg`, `./app.css`) as a
 *   module the loader makes itself, as Vite's dev server gives a Vite app's. Both dialects keep
 *   `off`.
 * - `reevaluateHookingExternals`: a `node_modules` package whose first load read the file's window
 *   or test globals is evaluated again in every later file of the worker (D221, #233).
 *   `@testing-library/dom` builds `screen` over `document.body` as it loads, so a shared copy
 *   searched the first file's body.
 * - `reevaluatePatchingExternals`: the same for a package whose first load added a key to the
 *   global or replaced one, which the environment's restore takes away after the file (D221, #233).
 *
 * The neutral policy keeps both `false`, so a package that reads and writes nothing per file stays
 * shared by the worker.
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
