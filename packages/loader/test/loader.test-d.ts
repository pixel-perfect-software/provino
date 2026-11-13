// The public API of @provino/loader.
import {
  type CoordinatorLoader,
  createCoordinatorLoader,
  createLoader,
  createProjectLoader,
  type LoaderError,
  type LoaderErrorCode,
} from '@provino/loader'
import {
  buildThirdPartyGraph,
  type ClosureEdge,
  type ClosureEdges,
  type EdgeKind,
  type GraphEdge,
  type GraphEntry,
  type GraphOptions,
  importersOf,
  initLexer,
  type Scan,
  scanSource,
  type ThirdPartyGraph,
} from '@provino/loader/graph'
import type {
  CreateLoader,
  FileRegistry,
  Loader,
  ModuleId,
  ModuleMapper,
  ModulePolicy,
  SerializedLoaderConfig,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(createLoader).toEqualTypeOf<CreateLoader>()
expectTypeOf(createLoader).returns.toEqualTypeOf<Loader>()
expectTypeOf<ReturnType<Loader['createFileRegistry']>>().toEqualTypeOf<FileRegistry>()
expectTypeOf<LoaderError['code']>().toEqualTypeOf<LoaderErrorCode>()
expectTypeOf<'ERR_REQUIRE_ASYNC_MODULE'>().toExtend<LoaderErrorCode>()
expectTypeOf<'LOADER_TSCONFIG_NOT_FOUND' | 'LOADER_INVALID_MAPPER'>().toExtend<LoaderErrorCode>()

declare const loader: Loader
// @ts-expect-error the process tier is a pool decision, never a registry tier
loader.createFileRegistry('/a.test.ts', { tier: 'process' })
declare const options: Parameters<CreateLoader>[0]
// @ts-expect-error not an engine
createLoader({ ...options, engine: 'jit' })
// @ts-expect-error exactOptionalPropertyTypes: conditions is omitted, not undefined
createLoader({ ...options, conditions: undefined })

// A worker's loader is built from the project's clone-safe settings, asynchronously (it loads the
// mappers' refs first).
declare const loaderConfig: SerializedLoaderConfig
declare const modulePolicy: ModulePolicy
expectTypeOf(createProjectLoader).parameters.toEqualTypeOf<
  [root: string, config: SerializedLoaderConfig, policy: ModulePolicy]
>()
expectTypeOf(createProjectLoader).returns.toEqualTypeOf<Promise<Loader>>()
void createProjectLoader('/repo', loaderConfig, modulePolicy)
// @ts-expect-error a loader has no config of its own to give: the policy is the `module` slice
void createProjectLoader('/repo', loaderConfig)
declare const mapperObject: ModuleMapper
// @ts-expect-error the config is the serialized one, so a mapper is a ref and not an object
const badMappers: SerializedLoaderConfig = { ...loaderConfig, mappers: [mapperObject] }
void badMappers

// `invalidate` is on every file registry.
declare const registry: FileRegistry
registry.invalidate('./setup.ts')
registry.invalidate('./setup.ts', '/repo/a.ts' as ModuleId)
// @ts-expect-error the parent is a branded ModuleId
registry.invalidate('./setup.ts', '/repo/a.ts')

// The node_modules graph is its own subpath entry (D52): nothing of it is on the root.
declare const graphOptions: GraphOptions
expectTypeOf(buildThirdPartyGraph).parameters.toEqualTypeOf<[options: GraphOptions]>()
expectTypeOf(buildThirdPartyGraph).returns.toEqualTypeOf<ThirdPartyGraph>()
expectTypeOf(importersOf).returns.toEqualTypeOf<readonly string[]>()
expectTypeOf(importersOf).parameter(1).toEqualTypeOf<string | readonly string[]>()
expectTypeOf(initLexer).returns.toEqualTypeOf<Promise<void>>()
expectTypeOf(scanSource).returns.toEqualTypeOf<Scan>()
expectTypeOf<GraphEdge['kind']>().toEqualTypeOf<EdgeKind>()
expectTypeOf<GraphEdge['target']>().toEqualTypeOf<string | null>()
const graph = buildThirdPartyGraph(graphOptions)
expectTypeOf(graph.reachable('/a.js')).toEqualTypeOf<readonly GraphEntry[]>()
expectTypeOf(graph.edgesOf('/a.js')).toEqualTypeOf<ClosureEdges>()
expectTypeOf<ClosureEdges['edges']>().toEqualTypeOf<readonly ClosureEdge[]>()
expectTypeOf<ClosureEdge['importer']>().toEqualTypeOf<string>()
expectTypeOf<GraphOptions['lockfileHash']>().toEqualTypeOf<string | null | undefined>()
// @ts-expect-error a closure's edges are read, not set
graph.edgesOf('/a.js').dynamic = true
// @ts-expect-error the graph's size is read, not set
graph.size = 1
// @ts-expect-error exactOptionalPropertyTypes: no cache is `null` or omitted
buildThirdPartyGraph({ ...graphOptions, cacheDir: undefined })
// @ts-expect-error a graph needs the worker's resolver
buildThirdPartyGraph({ root: '/repo' })
// @ts-expect-error importersOf takes the graph first
importersOf('/a.js', graph)

// The coordinator-mode loader (U5): the same settings as a worker's, a module imported by its
// absolute path, and the user modules it loaded.
expectTypeOf(createCoordinatorLoader).parameters.toEqualTypeOf<
  [root: string, config: SerializedLoaderConfig, policy: ModulePolicy]
>()
expectTypeOf(createCoordinatorLoader).returns.toEqualTypeOf<Promise<CoordinatorLoader>>()
declare const coordinator: CoordinatorLoader
expectTypeOf(coordinator.import<{ default: () => void }>('/setup.ts')).toEqualTypeOf<
  Promise<{ default: () => void }>
>()
expectTypeOf(coordinator.import('/setup.ts')).toEqualTypeOf<Promise<unknown>>()
expectTypeOf(coordinator.loadedModules()).toEqualTypeOf<readonly ModuleId[]>()
expectTypeOf(coordinator.dispose()).toEqualTypeOf<void>()
// @ts-expect-error a coordinator loader has no file registry or mocks: it imports files
coordinator.createFileRegistry('/setup.ts', { tier: 'none' })
// @ts-expect-error the file is an absolute path string
void coordinator.import(1)
// @ts-expect-error the policy is the `module` slice, never the whole policy
void createCoordinatorLoader('/repo', loaderConfig)
