// T2.2: the loader (Track 2 R1, R2). One loader per worker; one registry per test file.
// `registry` gives each file fresh user-module instances and shares node_modules natively;
// `none` shares one instance map across the worker. Mocks (T2.5 + T4.8, B13c) reach every edge
// through the file's module-mock registry. `realm` (T2.8), leak restore (T2.7), docblock
// escalation (T2.11) and the native engine (T2.10) arrive with their tasks.
import type {
  CreateLoader,
  FileRegistry,
  FileRegistryOptions,
  LoadActual,
  Loader,
  ModuleId,
  ModuleMockRegistry,
} from '@provino/types'
import { LoaderError } from './errors.ts'
import { conditionsOf } from './graph/conditions.ts'
import { saveGraph } from './internal/inline.ts'
import { loaderMessage } from './internal/messages.ts'
import { createRecords, resolveOrMissing } from './internal/records.ts'
import { type FileContext, NO_FILE, Registry } from './internal/registry.ts'
import { tierFor } from './tier.ts'

function notYet(what: string, task: string): LoaderError {
  return new LoaderError('LOADER_NOT_IMPLEMENTED', `${what} is not implemented yet (${task}).`)
}

/** The code of the module-mock registry's error for a mock that can't stand in for a relative path. */
const UNRESOLVED_RELATIVE_MOCK = 'unresolved-relative-mock'

/**
 * Creates a worker's loader.
 * @public
 */
export const createLoader: CreateLoader = (options) => {
  if (options.engine !== 'runner') throw notYet("engine: 'native'", 'T2.10')
  const state = createRecords(options)
  const conditions = conditionsOf(options)
  // The `none` tier: one instance map for every file in the worker.
  const shared = new Registry(state)

  function fileRegistry(testFile: string, registryOptions: FileRegistryOptions): FileRegistry {
    if (registryOptions.tier === 'realm') throw notYet('the realm tier', 'T2.8')
    const registry = registryOptions.tier === 'none' ? shared : new Registry(state)
    const importer = (parent: ModuleId | null | undefined): string => parent ?? testFile

    /** The id the actual paths load: the specifier resolved as a mock registration resolves it. */
    const actualId = (specifier: string, from: string): string => {
      const target = resolveOrMissing(state, specifier, from, options.policy.mockResolveKind)
      if (target.kind === 'missing' || target.kind === 'served') throw target.error
      return target.kind === 'external' ? target.path : target.id
    }
    const loadActual: LoadActual = (id, _importer, actualOptions) => {
      const scratch = actualOptions?.scratch === true
      return options.policy.actual === 'sync-require'
        ? registry.actualSync(id, scratch)
        : registry.actualAsync(id, scratch)
    }
    const mocks: ModuleMockRegistry | null =
      registryOptions.moduleMocks?.({ loadActual, resolver: options.resolver, conditions }) ?? null
    const context: FileContext = { mocks, scope: registryOptions.moduleScope ?? null }
    registry.context = context
    // The shared registry outlives the file: it counts what this file asks for (`loadedModules`).
    if (registryOptions.tier === 'none') registry.beginFile()
    const needMocks = (): ModuleMockRegistry => {
      if (mocks === null) {
        throw new LoaderError(
          'LOADER_NO_MODULE_MOCKS',
          `${testFile}'s registry has no module-mock registry (FileRegistryOptions.moduleMocks)`,
        )
      }
      return mocks
    }

    /**
     * The test file's own load. Where a mock can't stand in for a relative path, the dialect may
     * name the test file in the error (Vitest's module runner does; an import from inside a test
     * doesn't go through here).
     */
    const loadEntry = async (specifier: string): Promise<object> => {
      try {
        return await registry.load(specifier, testFile, true)
      } catch (error) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
        if (code !== UNRESOLVED_RELATIVE_MOCK || !(error instanceof Error)) throw error
        const message = loaderMessage(options.policy, 'unresolved-mock-import', {
          message: error.message,
          importer: testFile,
        })
        if (message === undefined) throw error
        throw new LoaderError('LOADER_UNRESOLVED_MOCK', message, { cause: error })
      }
    }

    const fileRegistry: FileRegistry = {
      file: testFile,
      tier: registryOptions.tier,
      import: <T>(specifier: string, parent?: ModuleId | null) =>
        (parent == null
          ? specifier === testFile
            ? loadEntry(specifier)
            : registry.load(specifier, testFile, false)
          : registry.importFrom(specifier, parent)) as Promise<T>,
      require: <T>(specifier: string, parent?: ModuleId | null) =>
        (parent == null
          ? registry.loadSync(specifier, testFile, specifier === testFile)
          : registry.requireFrom(specifier, parent)) as T,
      importActual: async <T>(specifier: string, parent?: ModuleId | null) =>
        (await registry.actualAsync(actualId(specifier, importer(parent)))) as T,
      requireActual: <T>(specifier: string, parent?: ModuleId | null) =>
        registry.actualSync(actualId(specifier, importer(parent))) as T,
      registerMock: (specifier, parent, spec, mockOptions) => {
        needMocks().register(specifier, spec, {
          from: importer(parent),
          ...(mockOptions?.virtual === true ? { virtual: true } : {}),
        })
      },
      unregisterMock: (specifier, parent) => {
        needMocks().register(specifier, { kind: 'unmock' }, { from: importer(parent) })
      },
      resetModules: () => {
        registry.reset()
        mocks?.onResetModules()
      },
      invalidate: (specifier, parent) => registry.invalidate(specifier, importer(parent)),
      isolateModules: (fn) => {
        mocks?.enterIsolation('isolateModules', 'isolateModulesAsync')
        try {
          return registry.isolate(fn)
        } finally {
          mocks?.exitIsolation()
        }
      },
      isolateModulesAsync: async (fn) => {
        mocks?.enterIsolation('isolateModulesAsync', 'isolateModules')
        try {
          return await registry.isolateAsync(fn)
        } finally {
          mocks?.exitIsolation()
        }
      },
      // Counted per file under `none` (`beginFile`), every instance of a file's own registry.
      loadedModules: () => registry.loadedByFile(),
      dispose: () => {
        mocks?.dispose()
        // What the file inlined, for its report; under `none` the instances go too, so the next
        // file sees the shared module.
        const inlinedForMocks = registry.inlined()
        if (registryOptions.tier === 'none') registry.dropInlined()
        // Under `none` the registry outlives the file: a later file sets its own context, and
        // code the file left behind finds no disposed registry in the meantime.
        if (registry.context === context) {
          registry.context = NO_FILE
          registry.endFile()
        }
        if (registryOptions.tier !== 'none') registry.reset()
        return {
          restored: [],
          prototypePatches: [],
          listenersAdded: [],
          activeResources: [],
          inlinedForMocks,
        }
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
    tierFor,
    onModuleCompiled: (listener) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    getSourceMap: (id) => state.records.get(id)?.map ?? null,
    [Symbol.dispose]: () => {
      // Once per worker, with everything its files scanned.
      saveGraph(state.inline)
      state.records.clear()
      state.externals.clear()
      state.required.clear()
      state.listeners.clear()
      shared.reset()
      shared.context = NO_FILE
    },
  }
  return loader
}
