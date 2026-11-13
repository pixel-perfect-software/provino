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
import type { FileRegistry, Loader, ModulePolicy, SerializedLoaderConfig } from '@provino/types'
import { createProjectLoader } from './project.ts'

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
): Promise<CoordinatorLoader> {
  // With no mocks there is nothing for the inlining walk to find, so the lexer and the graph stay off.
  const loader: Loader = await createProjectLoader(root, withoutMocks(config), {
    ...policy,
    mocksReachShared: false,
  })
  const registries: FileRegistry[] = []
  const coordinator: CoordinatorLoader = {
    import: <T>(file: string) => {
      const registry = loader.createFileRegistry(file, { tier: 'none' })
      registries.push(registry)
      return registry.import<T>(file)
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
