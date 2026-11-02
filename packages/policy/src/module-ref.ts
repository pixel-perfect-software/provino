import type { AnyFunction, ModuleRef } from '@provino/types'

export { isModuleRef } from './internal/objects.ts'

/**
 * Builds a `ModuleRef`. Pass an absolute path, a `file:` URL (`import.meta.resolve('./x.ts')`) or
 * a package specifier `@provino/policy` can resolve.
 * @public
 */
export function moduleRef<Fn extends AnyFunction>(
  module: string,
  exportName: string,
): ModuleRef<Fn> {
  return Object.freeze({ module, export: exportName })
}
