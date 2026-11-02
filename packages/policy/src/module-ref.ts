import type { AnyFunction, ModuleRef } from '@provino/types'
import { isPlainObject } from './internal/objects.ts'

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

/**
 * Whether a value is a `ModuleRef`: a plain object with string `module` and `export` and no other
 * own keys.
 * @public
 */
export function isModuleRef(value: unknown): value is ModuleRef {
  if (!isPlainObject(value)) return false
  return (
    Object.keys(value).length === 2 &&
    typeof value.module === 'string' &&
    typeof value.export === 'string'
  )
}
