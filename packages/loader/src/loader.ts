// T2.2: the loader (Track 2 R1, R2). One loader per worker; one registry per test file.
// `registry` gives each file fresh user-module instances and shares node_modules natively;
// `none` shares one instance map across the worker. `realm` (T2.8), mocks (T2.5), leak restore
// (T2.7), docblock escalation (T2.11) and the native engine (T2.10) arrive with their tasks.
import type {
  CreateLoader,
  FileRegistry,
  FileRegistryOptions,
  LeakReport,
  Loader,
  ModuleId,
} from '@provino/types'
import { LoaderError } from './errors.ts'
import { createRecords } from './internal/records.ts'
import { Registry } from './internal/registry.ts'

const EMPTY_LEAKS: LeakReport = {
  restored: [],
  prototypePatches: [],
  listenersAdded: [],
  activeResources: [],
  inlinedForMocks: [],
}

function notYet(what: string, task: string): LoaderError {
  return new LoaderError('LOADER_NOT_IMPLEMENTED', `${what} is not implemented yet (${task}).`)
}

/**
 * Creates a worker's loader.
 * @public
 */
export const createLoader: CreateLoader = (options) => {
  if (options.engine !== 'runner') throw notYet("engine: 'native'", 'T2.10')
  const state = createRecords(options)
  // The `none` tier: one instance map for every file in the worker.
  const shared = new Registry(state)

  function fileRegistry(testFile: string, registryOptions: FileRegistryOptions): FileRegistry {
    if (registryOptions.tier === 'realm') throw notYet('the realm tier', 'T2.8')
    const registry = registryOptions.tier === 'none' ? shared : new Registry(state)
    const importer = (parent: ModuleId | null | undefined): string => parent ?? testFile
    const isEntry = (specifier: string, parent: ModuleId | null | undefined) =>
      parent == null && specifier === testFile
    const fileRegistry: FileRegistry = {
      file: testFile,
      tier: registryOptions.tier,
      import: <T>(specifier: string, parent?: ModuleId | null) =>
        registry.import(specifier, importer(parent), isEntry(specifier, parent)) as Promise<T>,
      require: <T>(specifier: string, parent?: ModuleId | null) =>
        registry.require(specifier, importer(parent), isEntry(specifier, parent)) as T,
      // No mocks exist until T2.5, so the actual module is the module.
      importActual: <T>(specifier: string, parent?: ModuleId | null) =>
        registry.import(specifier, importer(parent), false) as Promise<T>,
      requireActual: <T>(specifier: string, parent?: ModuleId | null) =>
        registry.require(specifier, importer(parent), false) as T,
      registerMock: () => {
        throw notYet('registerMock', 'T2.5')
      },
      unregisterMock: () => {
        throw notYet('unregisterMock', 'T2.5')
      },
      resetModules: () => registry.reset(),
      invalidate: (specifier, parent) => registry.invalidate(specifier, importer(parent)),
      isolateModules: (fn) => registry.isolate(fn),
      isolateModulesAsync: (fn) => registry.isolateAsync(fn),
      loadedModules: () => registry.loaded(),
      dispose: () => {
        if (registryOptions.tier !== 'none') registry.reset()
        return EMPTY_LEAKS
      },
      [Symbol.dispose]: () => {
        fileRegistry.dispose()
      },
    }
    return fileRegistry
  }

  const loader: Loader = {
    engine: 'runner',
    createFileRegistry: fileRegistry,
    // Escalation by `@provino-isolate` is T2.11; until then the configured tier stands.
    tierFor: (_testFile, configured) => configured,
    onModuleCompiled: (listener) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    getSourceMap: (id) => state.records.get(id)?.map ?? null,
    [Symbol.dispose]: () => {
      state.records.clear()
      state.externals.clear()
      state.listeners.clear()
      shared.reset()
    },
  }
  return loader
}
