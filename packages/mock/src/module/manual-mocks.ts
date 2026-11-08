// `__mocks__` discovery, after jest-runtime's `Resolution.findManualMock` (internals/Resolution.ts
// L160-L240) and jest-resolve's `_lookupManualMock` (resolver.ts L605-L623):
//
// - A root mock: `<root>/__mocks__/<name>` for a package (`pkg`, `@scope/pkg`) or a core module,
//   where `node:fs` and `fs` are one name (a colon is no filename character on Windows).
// - An adjacent mock: `__mocks__/<file>` beside the resolved file.
import { statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, isAbsolute, join } from 'node:path'

/**
 * A manual mock the search found.
 * @public
 */
export interface ManualMock {
  /** The absolute path of the mock file. */
  readonly path: string
  /** `root` beside `node_modules`, or `adjacent` to the module it replaces. */
  readonly kind: 'root' | 'adjacent'
}

/**
 * Where to look.
 * @public
 */
export interface FindManualMockOptions {
  /** The directories whose `__mocks__` hold root mocks (Jest `roots`). */
  readonly roots: readonly string[]
  /** The extensions a mock file may have, with or without the dot (`.ts` or `ts`). */
  readonly extensions: readonly string[]
  /** The resolved file of a relative or absolute specifier, for the adjacent search. */
  readonly resolved?: string | null | undefined
}

const CORE_NAMES: ReadonlySet<string> = new Set(builtinModules)

/** Whether `specifier` names a Node core module, with or without `node:`. */
export function isCoreSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || CORE_NAMES.has(specifier)
}

/** `node:fs` and `fs` to `fs`: the name a root mock file has. */
export function coreName(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
}

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

function dotted(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`
}

/** A specifier that names a package or core module, not a relative or absolute path. */
export function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !isAbsolute(specifier) &&
    !/^[a-zA-Z]:[\\/]/.test(specifier)
  )
}

/** The roots that have a `__mocks__` directory: a search skips the rest. */
export function rootsWithMocks(roots: readonly string[]): readonly string[] {
  return roots.filter((root) => {
    try {
      return statSync(join(root, '__mocks__'), { throwIfNoEntry: false })?.isDirectory() === true
    } catch {
      return false
    }
  })
}

/**
 * Looks for the root mock of `specifier`: only a package or core name has one. Returns the first
 * root, then the first extension, that has the file.
 * @public
 */
export function findRootMock(
  specifier: string,
  options: Pick<FindManualMockOptions, 'roots' | 'extensions'>,
): ManualMock | null {
  // A `..` segment would climb out of `__mocks__`.
  if (!isBareSpecifier(specifier) || specifier.split(/[\\/]/).includes('..')) return null
  const name = isCoreSpecifier(specifier) ? coreName(specifier) : specifier
  for (const root of options.roots) {
    for (const extension of options.extensions) {
      const path = join(root, '__mocks__', `${name}${dotted(extension)}`)
      if (isFile(path)) return { path, kind: 'root' }
    }
  }
  return null
}

/**
 * Looks for the manual mock of a module: the root mock for a package or core name first, then
 * `__mocks__/<file>` beside the resolved file. Pure file-system reads; callers cache.
 * @public
 */
export function findManualMock(
  specifier: string,
  options: FindManualMockOptions,
): ManualMock | null {
  const root = findRootMock(specifier, options)
  if (root !== null) return root
  const resolved = options.resolved
  if (resolved === null || resolved === undefined || isCoreSpecifier(specifier)) return null
  const sibling = join(dirname(resolved), '__mocks__', basename(resolved))
  return isFile(sibling) ? { path: sibling, kind: 'adjacent' } : null
}
