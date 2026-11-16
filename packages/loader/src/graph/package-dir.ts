// The package a `node_modules` file belongs to: the loader's `packageClosure` and the
// coordinator's learned-externals versions (`@provino/orchestrator`) both name a package by it.

/**
 * The directory of the package a `node_modules` file belongs to (`…/node_modules/@scope/name`),
 * with `/` for separators, or `null` for a path that has no package directory (it is not under
 * `node_modules`, or it is a package's directory itself). The innermost `node_modules` counts, so a
 * nested copy is its own package.
 * @public
 */
export function packageDirOf(path: string): string | null {
  const normal = path.replaceAll('\\', '/')
  const at = normal.lastIndexOf('/node_modules/')
  if (at === -1) return null
  const start = at + '/node_modules/'.length
  const first = normal.indexOf('/', start)
  if (first === -1) return null
  if (normal[start] !== '@') return normal.slice(0, first)
  const second = normal.indexOf('/', first + 1)
  return second === -1 ? null : normal.slice(0, second)
}
