// T2.2: the loader (Track 2 R1, R2). One loader per worker; one registry per test file.
// `registry` gives each file fresh user-module instances and shares node_modules natively;
// `none` shares one instance map across the worker. Mocks (T2.5 + T4.8, B13c) reach every edge
// through the file's module-mock registry. `realm` (T2.8), leak restore (T2.7), docblock
// escalation (T2.11) and the native engine (T2.10) arrive with their tasks.
import { existsSync } from 'node:fs'
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
import { edgeConditions } from './internal/edge-kind.ts'
import { saveGraph } from './internal/inline.ts'
import { loaderMessage } from './internal/messages.ts'
import {
  CODE_CACHE_WRITE_BATCH,
  createRecords,
  dropRecords,
  resolveOrMissing,
  toModuleId,
} from './internal/records.ts'
import { activate, promoteLearned, takeLearned } from './internal/reevaluate.ts'
import { type FileContext, NO_FILE, Registry } from './internal/registry.ts'
import { blankHashbang } from './internal/source.ts'
import { isEvaluableExternal } from './internal/third-party.ts'
import { pathOfUrl } from './internal/url.ts'
import { reevaluatesExternals } from './reevaluation.ts'
import { tierFor } from './tier.ts'

function notYet(what: string): LoaderError {
  return new LoaderError('LOADER_NOT_IMPLEMENTED', `${what} is not implemented yet.`)
}

/** The code of the module-mock registry's error for a mock that can't stand in for a relative path. */
const UNRESOLVED_RELATIVE_MOCK = 'unresolved-relative-mock'

/**
 * Creates a worker's loader.
 * @public
 */
export const createLoader: CreateLoader = (options) => {
  if (options.engine !== 'runner') throw notYet("engine: 'native'")
  const state = createRecords(options)
  // A registration resolves as an edge of its kind does (`ModulePolicy.moduleSyncCondition`).
  const conditions = edgeConditions(state.edgeKinds, options.policy.mockResolveKind)
  // The `none` tier: one instance map for every file in the worker.
  const shared = new Registry(state, true)

  function fileRegistry(testFile: string, registryOptions: FileRegistryOptions): FileRegistry {
    if (registryOptions.tier === 'realm') throw notYet('the realm tier')
    // What an earlier file's loads learned is evaluated per file from this one on (D127).
    promoteLearned(state.reevaluate)
    const registry = registryOptions.tier === 'none' ? shared : new Registry(state)
    const importer = (parent: ModuleId | null | undefined): string => parent ?? testFile

    /** The id the actual paths load: the specifier resolved as a mock registration resolves it. */
    const actualId = (specifier: string, from: string): string => {
      const target = resolveOrMissing(state, specifier, from, options.policy.mockResolveKind, true)
      if (target.kind === 'missing' || target.kind === 'served') throw target.error
      return target.kind === 'external' ? target.path : target.id
    }
    const loadActual: LoadActual = (id, _importer, actualOptions) => {
      const scratch = actualOptions?.scratch === true
      if (options.policy.actual === 'sync-require' || actualOptions?.sync === true) {
        return registry.actualSync(id, scratch)
      }
      return actualOptions?.moduleValue === true
        ? registry.actualValueAsync(id, scratch)
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
    const loadEntry = async (specifier: string, evaluated?: () => void): Promise<object> => {
      try {
        return await registry.load(specifier, testFile, true, evaluated)
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
      import: <T>(specifier: string, parent?: ModuleId | null, evaluated?: () => void) =>
        (parent == null
          ? specifier === testFile
            ? loadEntry(specifier, evaluated)
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
      leakTargets: () => [registry],
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
        // Every script the file compiled has run by now, so its entry holds the functions the
        // file's tests compiled lazily too. A file that left few waiting adds no pack of its own.
        const { codeCache } = state
        if (codeCache !== null && codeCache.pending >= CODE_CACHE_WRITE_BATCH) codeCache.write()
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
    dropRecords: (paths) => {
      dropRecords(state, paths)
    },
    compiledModule: (url) => {
      // V8 reports a vm script by the `file:` URL of its filename; a path is accepted too.
      const path = pathOfUrl(url)
      const record = state.records.get(toModuleId(path))
      if (record === undefined || record.wrapperLength === null) return null
      return {
        path: record.path,
        // What V8 compiled after the wrapper (the hashbang a comment, the same length).
        code: blankHashbang(record.source),
        wrapperLength: record.wrapperLength,
        map: record.map,
        transformKey: record.transformKey,
      }
    },
    watchExternalLoads: (watcher) => {
      // With the policy off nothing is watched, so no window is ever opened.
      if (!reevaluatesExternals(options.policy)) return () => {}
      state.reevaluate.watchers.add(watcher)
      return () => {
        state.reevaluate.watchers.delete(watcher)
      }
    },
    takeLearnedExternals: () => takeLearned(state.reevaluate),
    reevaluateExternals: (paths) => {
      if (!reevaluatesExternals(options.policy)) return
      // A set from an earlier run may name a file a reinstall removed, or one the loader can't
      // evaluate itself: those stay shared.
      activate(
        state.reevaluate,
        paths.filter((path) => isEvaluableExternal(path, state.inlineRules) && existsSync(path)),
      )
    },
    [Symbol.dispose]: () => {
      // Once per worker, with everything its files scanned.
      saveGraph(state.inline)
      // What no file end wrote: the last files' few scripts, a worker's only file.
      state.codeCache?.write()
      state.codeCache?.close()
      state.records.clear()
      state.externals.clear()
      state.required.clear()
      state.listeners.clear()
      state.reevaluate.watchers.clear()
      shared.reset()
      shared.context = NO_FILE
    },
  }
  return loader
}
