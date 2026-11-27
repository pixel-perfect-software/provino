import type { ModulePolicy } from '@provino/types'

/**
 * The native runtime's module settings: a project with no dialect imports an asset or style file
 * (`./logo.svg`, `./app.css`) as a module the loader makes itself (`ModulePolicy.assetImports`).
 * Provino's own value, as Vite's dev server gives a Vite app's: `@provino/config` layers it for a
 * project with no dialect, and both dialects keep `off`.
 * @public
 */
export const nativeModulePolicy: Pick<ModulePolicy, 'assetImports'> = {
  assetImports: 'built-in',
}
