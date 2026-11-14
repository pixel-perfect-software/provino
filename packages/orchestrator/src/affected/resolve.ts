// T9.12: specifiers to files. Edges resolve through the project's loader (its mappers, extensions and
// resolver), with the export conditions the policy's `affected.conditions` says; a builtin no mapper
// takes is no edge. Mock edges follow the policy's `affected.mockEdges`: the shape of
// jest-resolve-dependencies' `resolve` (L40-99), as data.

import { builtinModules } from 'node:module'
import { basename, dirname, extname, join } from 'node:path'
import type { OrchestratorPolicy } from '@provino/types'

type MockEdges = OrchestratorPolicy['affected']['mockEdges']

/**
 * The conditions of `affected.conditions: 'none'`: what a `require` lookup with no environment
 * conditions matches (jest-resolve's `defaultResolver`, L181-187, when it is given none).
 */
const REQUIRE_DEFAULTS: readonly string[] = ['require', 'node', 'default']

/** The conditions an edge resolves with: `undefined` keeps the loader's (the environment's). */
export function graphConditions(
  conditions: OrchestratorPolicy['affected']['conditions'],
): readonly string[] | undefined {
  return conditions === 'none' ? REQUIRE_DEFAULTS : undefined
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules)

/** `fs`, `node:fs`, `fs/promises`: a Node core module, which is no edge. */
export function isBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return BUILTINS.has(specifier)
}

/** What resolves a specifier from a file. */
export interface DependencyResolver {
  /** `undefined` for a miss and for a Node builtin no mapper takes. */
  resolveDependency(
    specifier: string,
    from: string,
    options?: { readonly conditions?: readonly string[] },
  ): string | undefined
  /** Drops what the resolver cached of the file system: files were added or removed. */
  invalidateResolution?(paths?: readonly string[]): void
}

/**
 * The project's mock files by name: a file under a `<dir>/` directory is a mock named by its path
 * from that directory without the extension (`__mocks__/a/b.js` is `a/b`; the first `<dir>` in
 * the path counts, as `getMockName` splits).
 * @internal
 */
export interface MockIndex {
  /** The mock of this name anywhere in the project (the first by path). */
  byName(name: string): string | undefined
  /** The mock named `name` in the `<dir>` directory beside `directory`'s files. */
  adjacent(directory: string, name: string): string | undefined
}

const NO_MOCKS: MockIndex = { byName: () => undefined, adjacent: () => undefined }

function withoutExtension(path: string): string {
  const extension = extname(path)
  return extension === '' ? path : path.slice(0, path.length - extension.length)
}

/** Indexes the mock files among `files` for a mock directory name. */
export function indexMocks(files: Iterable<string>, mockEdges: MockEdges): MockIndex {
  if (mockEdges === null) return NO_MOCKS
  const marker = `/${mockEdges.dir}/`
  const named = new Map<string, string>()
  const beside = new Map<string, string>()
  for (const file of files) {
    const at = file.indexOf(marker)
    if (at < 0) continue
    const name = withoutExtension(file.slice(at + marker.length))
    if (!named.has(name)) named.set(name, file)
    // Beside its directory: `<dir>/__mocks__/<name>` only (a mock in a sub-directory isn't).
    if (!name.includes('/')) beside.set(`${file.slice(0, at)}\0${name}`, file)
  }
  return {
    byName: (name) => named.get(name),
    adjacent: (directory, name) => beside.get(`${directory}\0${name}`),
  }
}

/**
 * The files `from` depends on, resolved: each specifier's file, and the mock beside it. A
 * specifier that doesn't resolve is the root mock of its name when the policy says `byName`.
 * @internal
 */
export function resolveEdges(
  from: string,
  specifiers: Iterable<string>,
  options: {
    readonly resolver: DependencyResolver
    readonly mocks: MockIndex
    readonly mockEdges: MockEdges
    /** The export conditions in place of the project's (`graphConditions`); absent keeps them. */
    readonly conditions?: readonly string[] | undefined
  },
): Set<string> {
  const { resolver, mocks, mockEdges, conditions } = options
  const lookup = conditions === undefined ? undefined : { conditions }
  const found = new Set<string>()
  for (const specifier of specifiers) {
    // The resolver first: a mapper may take a builtin's name (jest-resolve's `isCoreModule` is a
    // builtin that no `moduleNameMapper` rule matches).
    let resolved = resolver.resolveDependency(specifier, from, lookup)
    if (resolved === undefined && isBuiltinSpecifier(specifier)) continue
    if (resolved === undefined && mockEdges?.byName === true) resolved = mocks.byName(specifier)
    if (resolved === undefined) continue
    found.add(resolved)
    if (mockEdges?.adjacent === true) {
      const mock = mocks.adjacent(dirname(resolved), basename(specifier))
      if (mock !== undefined) found.add(join(mock))
    }
  }
  return found
}
