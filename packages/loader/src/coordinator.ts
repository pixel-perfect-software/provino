// U5: the loader in coordinator mode. The coordinator imports a few modules itself (a global setup
// or teardown, T9.15) and they need what a test file needs: the project's transform (Oxc for
// TypeScript, or the project's own Jest transformers), its resolver and its mappers. This is
// `createProjectLoader`'s engine with one tier, `none`: one instance map for everything it loads,
// so a setup and the teardown that follows see the same module state.
//
// Nothing here is process-global. Modules are compiled with `vm` and run by the loader's own
// linker; no `module.registerHooks` or `require.extensions` hook is installed, so what the
// coordinator itself imports (Provino's own code, the config) resolves as it did. There is no
// module-mock registry (`jest.mock` in a global setup is out of scope, as in Jest, where it
// doesn't apply) and no per-module bindings: a module that names `jest` sees the global of that
// name, which a coordinator doesn't have.
import { readFileSync } from 'node:fs'
import { sep } from 'node:path'
import type {
  FileRegistry,
  Loader,
  ModulePolicy,
  Pipeline,
  Resolver,
  SerializedLoaderConfig,
  SourceMapV3,
} from '@provino/types'
import { buildProjectLoader, type ProjectCoverage } from './project.ts'

/**
 * A loader for modules the coordinator runs itself.
 * @public
 */
export interface CoordinatorLoader extends Disposable {
  /**
   * Imports the module at `file` (an absolute path) through the project's transform, and resolves
   * with its exports as an `import` sees them under the policy's `interopDefault`. The module
   * itself is never mocked. A module imported twice is evaluated once.
   */
  import<T = unknown>(file: string): Promise<T>
  /**
   * `file` (an absolute path) transformed as a worker transforms a covered file: through the
   * project's transform with the instrumenter, before the module-runner rewrite. For files the
   * tests never loaded. Needs the loader to have been created with `coverage`.
   */
  transformForCoverage(file: string): { readonly code: string; readonly map: SourceMapV3 | null }
  /**
   * What `specifier` imported from `from` (an absolute path) resolves to, as a `require` resolves
   * it under the project's mappers, or `undefined` when it doesn't resolve or is a Node builtin
   * no mapper takes. For the affected-test graph (B23c). `options.conditions` replaces the
   * project's export conditions (the call's `require` is added either way). Under the config's
   * `skipNodeResolution`, a specifier with no path separator resolves only through a mapper, as
   * jest-resolve's `_prepareForResolution` skips its node lookup.
   */
  resolveDependency(
    specifier: string,
    from: string,
    options?: { readonly conditions?: readonly string[] },
  ): string | undefined
  /**
   * Drops the resolver's file-system caches (for the given paths, or all of them): call it when
   * files were added or removed, or a specifier that missed would keep missing.
   */
  invalidateResolution(paths?: readonly string[]): void
  /** Forgets every module; further imports start over. */
  dispose(): void
}

/**
 * The part of a worker's loader config a coordinator-mode loader leaves out: the dialect's mock
 * hoisting (there is no mock registry for a hoisted call to reach) and its per-module bindings.
 */
function withoutMocks(config: SerializedLoaderConfig): SerializedLoaderConfig {
  const { scopeModules: _modules, scopeMappable: _mappable, ...rest } = config
  return { ...rest, hoist: null, moduleScope: [] }
}

/**
 * Creates the coordinator-mode loader of one project: its resolver, mappers and transform (the
 * Jest transformers load here, in this process, from their own paths), at the isolation tier
 * `none`. `config` is the project's `SerializedLoaderConfig`, the one its workers build theirs
 * from, so a file resolves and transforms here as it does there.
 * @public
 */
export async function createCoordinatorLoader(
  root: string,
  config: SerializedLoaderConfig,
  policy: ModulePolicy,
  options: { readonly coverage?: ProjectCoverage } = {},
): Promise<CoordinatorLoader> {
  // With no mocks there is nothing for the inlining walk to find, so the lexer and the graph stay off.
  const built: {
    readonly loader: Loader
    readonly pipeline: Pipeline
    readonly resolver: Resolver
  } = await buildProjectLoader(
    root,
    withoutMocks(config),
    { ...policy, mocksReachShared: false },
    options,
  )
  const { loader, pipeline, resolver } = built
  const registries: FileRegistry[] = []
  const coordinator: CoordinatorLoader = {
    import: <T>(file: string) => {
      const registry = loader.createFileRegistry(file, { tier: 'none' })
      registries.push(registry)
      return registry.import<T>(file)
    },
    transformForCoverage: (file) => {
      if (options.coverage === undefined) {
        throw new Error('transformForCoverage needs a loader created with `coverage`')
      }
      const record = pipeline.transform({
        filename: file,
        source: readFileSync(file, 'utf8'),
        role: 'source',
        consumer: 'import',
        instrument: true,
      })
      return { code: record.code, map: record.map }
    },
    resolveDependency: (specifier, from, options) => {
      const result = resolver.resolve(specifier, {
        importer: from,
        kind: 'require',
        conditions: options?.conditions ?? config.conditions,
      })
      if (result.type !== 'file') return undefined
      // jest-resolve skips only the node lookup: a mapper still answers for the name.
      if (
        config.skipNodeResolution === true &&
        !specifier.includes(sep) &&
        result.mappedBy === null
      ) {
        return undefined
      }
      return result.path
    },
    invalidateResolution: (paths) => {
      resolver.invalidate(paths)
    },
    dispose: () => {
      for (const registry of registries.splice(0)) registry.dispose()
      loader[Symbol.dispose]()
    },
    [Symbol.dispose]: () => {
      coordinator.dispose()
    },
  }
  return coordinator
}
