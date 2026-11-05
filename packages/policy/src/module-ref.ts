import { isAbsolute } from 'node:path'
import type { AnyFunction, ModuleRef } from '@provino/types'
import { isModuleRef } from './internal/objects.ts'

export { isModuleRef }

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
 * Whether a worker can import `location` as it is (D21): an absolute path or a URL (`file:`,
 * `data:`, `node:`). A bare package specifier or a relative path would resolve from the worker's
 * own location, not the project's.
 * @public
 */
export function isImportableLocation(location: string): boolean {
  return isAbsolute(location) || URL.canParse(location)
}

/**
 * Calls `visit` with each ref found in `value` and its key path, which starts at `path` and is
 * dotted (`policy.core.formatEachTitle`), with an index for an array item (`list[0]`). A ref is
 * what `isRef` says it is (a `ModuleRef`, by default) and is not searched further. `seen` stops a
 * cyclic value, which structured clone can carry, from looping.
 * @public
 */
export function forEachModuleRef(
  value: unknown,
  path: string,
  visit: (ref: ModuleRef, path: string) => void,
): void
export function forEachModuleRef<Ref>(
  value: unknown,
  path: string,
  visit: (ref: Ref, path: string) => void,
  isRef: (value: unknown) => value is Ref,
): void
export function forEachModuleRef(
  value: unknown,
  path: string,
  visit: (ref: never, path: string) => void,
  isRef: (value: unknown) => boolean = isModuleRef,
): void {
  walk(value, path, visit, isRef, new Set())
}

function walk(
  value: unknown,
  path: string,
  visit: (ref: never, path: string) => void,
  isRef: (value: unknown) => boolean,
  seen: Set<object>,
): void {
  if (isRef(value)) {
    visit(value as never, path)
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      walk(item, `${path}[${index}]`, visit, isRef, seen)
    })
    return
  }
  for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, visit, isRef, seen)
}
