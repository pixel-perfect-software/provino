// The worker-wide half of the engine (Track 2 R1 steps 1–2): each user module is transformed and
// compiled once per worker, its static deps are resolved once, and shared externals are loaded
// natively. Records never hold per-file state; that lives in a registry's instances.
import { readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { LATE_IMPORT, toModuleRunner, usesModuleRunnerForm } from '@provino/transform'
import { openV8Pack, type V8Pack } from '@provino/transform/v8cache'
import type {
  CompiledModuleEvent,
  LoaderOptions,
  ModuleId,
  ResolveKind,
  ResolveResult,
  SourceMapV3,
} from '@provino/types'
import { LoaderError, ModuleNotFoundError } from '../errors.ts'
import { type GraphEdge, inGraph } from '../graph/index.ts'
import { reevaluatesExternals } from '../reevaluation.ts'
import { type ClaimsState, compileClaims, isClaimedExternal } from './claims.ts'
import {
  createEdgeKindState,
  type EdgeKindState,
  edgeConditions,
  edgeKind,
  type RuntimeCapabilities,
} from './edge-kind.ts'
import {
  conditionalReach,
  createInlineState,
  divergingConditions,
  type InlinePerFileSources,
  type InlineState,
  servedReach,
  type UserEdges,
} from './inline.ts'
import { loaderMessage } from './messages.ts'
import { createReevaluateState, type ReevaluateState } from './reevaluate.ts'
import { blankHashbang, CJS_PARAMS } from './source.ts'
import { type InlineRules, isEvaluableExternal, isThirdParty, NO_RULES } from './third-party.ts'

/**
 * Where a specifier leads. `missing` is a specifier that doesn't resolve, and `failed` a user module
 * that doesn't transform (a `.css` file, a syntax error): both are recorded when the graph is linked
 * and thrown only when the edge runs, after the mock registry had its say (a `virtual` mock, a
 * factory for `./styles.css`, `try { require('optional') } catch {}`; B13c Gap 7 and the review).
 */
export type Target =
  | { readonly kind: 'user'; readonly id: ModuleId }
  | { readonly kind: 'external'; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: string }
  | { readonly kind: 'missing'; readonly error: ModuleNotFoundError }
  /**
   * A module the dialect serves (`ModuleScope.modules`, Jest's `@jest/globals`): never resolved or
   * loaded, its edge reads the scope's value first (`FileRegistry.#served`). Its `error`, what the
   * edge throws when the scope has no value for it, is made only when read.
   */
  | { readonly kind: 'served'; readonly error: ModuleNotFoundError }
  | { readonly kind: 'failed'; readonly id: ModuleId; readonly error: unknown }

/** A target that leads somewhere loadable. */
export type Found = Extract<Target, { readonly kind: 'user' | 'external' | 'builtin' }>

export type UserFormat = 'esm' | 'cjs' | 'json'

/** A compiled wrapper. With scope bindings it is the outer function, which returns the wrapper. */
export type Compiled = (...args: unknown[]) => unknown

/**
 * A record's wrapper in one mode: the script, compiled once per worker, whose run makes the wrapper
 * function. Each run of the same script makes a new function with feedback of its own, from the
 * script's compiled code: nothing is parsed again (V8 recompiles only a function whose bytecode it
 * flushed, as it would under one wrapper).
 */
export interface WrapperScript {
  readonly script: Script
  /** The function the script's first run made, which a registry shared across files calls again. */
  shared: Compiled | null
}

/** One user module, as every registry in the worker shares it. */
export interface ModuleRecord {
  readonly id: ModuleId
  /** The file it reads: the id less a query or fragment (`fileOf`); the id itself otherwise. */
  readonly path: string
  readonly format: UserFormat
  /** The wrapper source, or the JSON text. */
  readonly source: string
  /** Read on demand: composing it is not free, and nothing asks on a warm run. */
  readonly map: SourceMapV3 | null
  /** Static deps: import specifiers (ESM) or literal `require` specifiers (CJS). */
  readonly deps: readonly string[]
  /** Imports the hoister made late (D38): never linked ahead, loaded when their call runs. */
  readonly lateDeps: readonly string[]
  readonly hasTopLevelAwait: boolean
  /**
   * A node_modules file inlined for a file's mocks (T2.6): transformed as a dependency, so it is
   * never hoisted, and reported to coverage as third party.
   */
  readonly thirdParty: boolean
  /**
   * A CommonJS module that calls `import()`: its source is the module-runner form, which names the
   * call `__vite_ssr_dynamic_import__`, and its wrapper takes that binding as a sixth parameter. A
   * `vm` script has no import callback, so a bare `import()` there fails
   * (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), and one script is shared by every file's registry,
   * so the call has to reach the registry that evaluated the module through a binding, as an ES
   * module's does.
   */
  readonly dynamicImport: boolean
  /** Its static subgraph has top-level await, so it evaluates with the async wrapper. */
  asyncGraph: boolean
  /**
   * Its static subgraph has a module with late deps (D38), so an `import` of it evaluates async: a
   * late dependency with top-level await then works however the module was reached.
   */
  lateGraph: boolean
  readonly resolved: Map<string, Target>
  linked: boolean
  /** The plain wrapper (`await` stripped from its import calls) and the async one, each compiled on first use. */
  compiledSync: WrapperScript | null
  compiledAsync: WrapperScript | null
  /**
   * The scope bindings this module's source names, in the worker's order (B13c Gap 2): the
   * dialect's per-module names, and for ES modules under `injectCjsGlobals` `require`,
   * `__filename` and `__dirname`. Found by a word scan at the first compile; a module that names
   * none gets no outer function and pays nothing.
   */
  scope: readonly string[] | null
  /** The transform cache key of this module's variant (coverage maps V8's scripts by it); empty for JSON. */
  transformKey: string
  /** Characters the wrapper put before the body, once compiled (the same in both modes). */
  wrapperLength: number | null
}

/** The wrapper parameters, in order. ESM gets Vite's linkers and the late import; CJS gets Node's wrapper. */
const DYNAMIC_IMPORT = '__vite_ssr_dynamic_import__'
const ESM_PARAMS = `__vite_ssr_exports__, __vite_ssr_import_meta__, __vite_ssr_import__, ${DYNAMIC_IMPORT}, __vite_ssr_exportAll__, ${LATE_IMPORT}`
/** What an ES module gets under `ModulePolicy.injectCjsGlobals`, when its source names them. */
const CJS_GLOBALS: readonly string[] = ['require', '__filename', '__dirname']

export function toModuleId(path: string): ModuleId {
  return path as ModuleId
}

const DATA = 'data:'

/** Node's reading of a `data:` URL (`internal/modules/esm/load`): its MIME type, base64 or not, and body. */
const DATA_URL = /^([^/]+\/[^;,]+)(?:[^,]*?)(;base64)?,([\s\S]*)$/

/**
 * The source of a `data:` module, decoded as Node decodes it, and whether it is JSON. Only the
 * types Node's default loader takes as source: `text/javascript` and `application/json`.
 */
function dataSource(id: string): { readonly json: boolean; readonly text: string } {
  const match = DATA_URL.exec(new URL(id).pathname)
  const mime = match?.[1]
  if (match === null || (mime !== 'text/javascript' && mime !== 'application/json')) {
    throw new LoaderError(
      'LOADER_UNSUPPORTED_MODULE',
      `cannot load a data: URL of type ${mime ?? 'unknown'} as a module`,
    )
  }
  const body = decodeURIComponent(match[3] ?? '')
  const text = Buffer.from(body, match[2] === undefined ? 'utf8' : 'base64').toString('utf8')
  return { json: mime === 'application/json', text }
}

/** Where a module id's query or fragment starts (`./x.ts?v`, `./x.ts#f`), in its last segment. */
function suffixStart(id: string): number {
  const segment = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\')) + 1
  const at = id.slice(segment).search(/[?#]/)
  return at === -1 ? -1 : segment + at
}

/**
 * The file a module id reads. The resolver keeps a specifier's query or fragment on the path it
 * finds (`import('./x.ts?v')`), so, as in Node, two URLs of one file are two modules, each
 * evaluated once, that read the same file. A file whose name holds the `?` or `#` is that file.
 * Only an id with either character pays for the `stat` (speed).
 */
export function fileOf(id: string): string {
  if (id.startsWith(DATA)) return id
  const at = suffixStart(id)
  if (at === -1 || statSync(id, { throwIfNoEntry: false }) !== undefined) return id
  return id.slice(0, at)
}

/** A module id's `file:` URL, its query or fragment kept as written (Node's `import.meta.url`). */
export function urlOf(id: string): string {
  if (id.startsWith(DATA)) return id
  const path = fileOf(id)
  return pathToFileURL(path).href + id.slice(path.length)
}

/**
 * Whether a resolved file loads natively, shared by the worker: an addon, or a `node_modules` file
 * `inline` doesn't name and no transform takes as a user module.
 */
function isExternal(state: Records, path: string): boolean {
  if (path.endsWith('.node')) return true
  return state.claims === null
    ? isThirdParty(path, state.inlineRules)
    : isClaimedExternal(state.claims, path)
}

export interface Records {
  readonly options: LoaderOptions
  /** The node_modules graph and what inlining warned (T2.6). */
  readonly inline: InlineState
  readonly records: Map<ModuleId, ModuleRecord>
  /** Native namespaces of shared externals and builtins (`import()`), by path or `node:` id. */
  readonly externals: Map<string, object>
  /** Natively required values of shared externals and builtins, by path or `node:` id. */
  readonly required: Map<string, unknown>
  readonly listeners: Set<(event: CompiledModuleEvent) => void>
  /** The shared externals evaluated per file because their first load read a per-file global (D127). */
  readonly reevaluate: ReevaluateState
  /** Which importers run as ES modules, for `ModulePolicy.edgeResolveKind`. */
  readonly edgeKinds: EdgeKindState
  /** `LoaderOptions.inline`, normalized once. */
  readonly inlineRules: InlineRules
  /** The files the transforms take (`LoaderOptions.transformClaims`); `null` for none. */
  readonly claims: ClaimsState | null
  /**
   * The conditions that tell the loader's resolution from a native load's (`divergingConditions`),
   * where the policy evaluates externals as Jest's registry does (`reevaluatesExternals`): an
   * external whose closure Node would resolve otherwise is inlined (`conditionalReach`). `null`:
   * none, or the policy loads externals as Node does.
   */
  readonly diverging: ReadonlySet<string> | null
  /** Whether a node_modules file could be evaluated per file (`isEvaluableExternal`), built once. */
  readonly evaluable: (path: string) => boolean
  /** `userEdgesOf` for this worker, built once. */
  readonly userEdges: UserEdges
  /** What the per-file set (D132) reads besides its graph, built once. */
  readonly perFileSources: InlinePerFileSources
  /** The scope names a module of each format can be given, in order. */
  readonly scopeNames: { readonly esm: readonly string[]; readonly cjs: readonly string[] }
  /** One word-scan pattern per scope name. */
  readonly scopePatterns: ReadonlyMap<string, RegExp>
  /**
   * The records that name each module id as a `user` target in `resolved` (a reverse edge index,
   * for `markAsyncGraphs`). Only ever added to, as a defence: should `setResolved` overwrite a
   * `user` target, the stale entry costs a record a needless look at its targets, never a missed
   * flag.
   */
  readonly importers: Map<ModuleId, Set<ModuleRecord>>
  /**
   * The records whose `asyncGraph`/`lateGraph` may be behind what their targets say, since
   * `markAsyncGraphs` last ran: one whose `resolved` gained a `user` target, and the importers of a
   * module whose record was made. `markAsyncGraphs` empties it.
   */
  readonly graphsDirty: Set<ModuleRecord>
  /**
   * V8's code cache of the wrapper scripts (`LoaderOptions.codeCache`, B23e), or `null` for none.
   * `wrapperScript` compiles through it; the loader writes what it queued after a file
   * (`CODE_CACHE_WRITE_BATCH`) and when it is disposed.
   */
  readonly codeCache: V8Pack | null
}

/**
 * A test file's end writes the wrapper scripts the code cache queued once this many are waiting;
 * the loader's dispose writes the rest. So a worker's first file, which compiles the shared graph,
 * leaves its entries at once (a worker killed later keeps them), and a later file that compiled only
 * itself and a few modules adds no pack of its own.
 */
export const CODE_CACHE_WRITE_BATCH = 64

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `runtime` is what this Node can do, probed when first asked for; a test passes its own. */
export function createRecords(options: LoaderOptions, runtime?: RuntimeCapabilities): Records {
  const dialect = options.moduleScope?.names ?? []
  const esm = [
    ...dialect,
    ...(options.policy.injectCjsGlobals
      ? CJS_GLOBALS.filter((name) => !dialect.includes(name))
      : []),
  ]
  const scopePatterns = new Map(
    esm.map((name) => [name, new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`)]),
  )
  const inline = createInlineState()
  const externals = new Map<string, object>()
  const required = new Map<string, unknown>()
  const edgeKinds = createEdgeKindState(options, runtime)
  const inlineRules = options.inline ?? NO_RULES
  const claims = compileClaims(options, { edgeKinds, inline, inlineRules, required, externals })
  const evaluable = (path: string): boolean => isEvaluableExternal(path, inlineRules)
  const userEdges: UserEdges = (path) => userEdgesOf(state, path)
  const served = options.moduleScope?.modules ?? []
  const diverging = reevaluatesExternals(options.policy) ? divergingConditions(options) : null
  const state: Records = {
    options,
    inline,
    records: new Map(),
    externals,
    required,
    listeners: new Set(),
    reevaluate: createReevaluateState(),
    edgeKinds,
    inlineRules,
    claims,
    diverging,
    evaluable,
    userEdges,
    perFileSources: {
      claimed: claims?.users ?? [],
      loaded: required,
      keep: evaluable,
      userEdges,
      // Inlined in every file, for a served module or for Node's other resolution: never Node's copy.
      elsewhere:
        served.length === 0 && diverging === null
          ? null
          : (path) =>
              inGraph(path) &&
              ((served.length > 0 && servedReach(inline, options, path, served, userEdges)) ||
                (diverging !== null &&
                  conditionalReach(inline, options, path, diverging, userEdges))),
    },
    scopeNames: { esm, cjs: dialect },
    scopePatterns,
    importers: new Map(),
    graphsDirty: new Set(),
    codeCache: options.codeCache == null ? null : openV8Pack({ dir: options.codeCache }),
  }
  return state
}

/**
 * The error for a specifier that doesn't resolve: the dialect's `module-not-found` text, with
 * Node's code for the kind of call (`MODULE_NOT_FOUND` for `require`, else `ERR_MODULE_NOT_FOUND`).
 */
function notFound(
  state: Records,
  specifier: string,
  importer: string,
  kind: ResolveKind,
  miss?: Extract<ResolveResult, { readonly type: 'not-found' }>,
): ModuleNotFoundError {
  const from = relative(state.options.root, importer).split(sep).join('/')
  const message =
    (miss === undefined ? undefined : mapperMissMessage(state, specifier, miss)) ??
    loaderMessage(state.options.policy, 'module-not-found', { specifier, from, importer }) ??
    `Cannot find module '${specifier}' imported from ${importer}`
  return new ModuleNotFoundError(
    kind === 'require' ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND',
    message,
  )
}

/**
 * The text for a name-mapper rule that matched with no target resolving, or `undefined` when the
 * miss isn't one, or the dialect has no text for it.
 */
function mapperMissMessage(
  state: Records,
  specifier: string,
  miss: Extract<ResolveResult, { readonly type: 'not-found' }>,
): string | undefined {
  const { mappedBy, declared, tried } = miss
  const { formatMapperMiss } = state.options
  if (formatMapperMiss === undefined || mappedBy === null || declared === undefined) {
    return undefined
  }
  return formatMapperMiss({
    specifier,
    rule: mappedBy,
    declared,
    tried,
    resolver: state.options.resolverName,
  })
}

/**
 * Whether a name-mapper rule takes over a served module (`ModuleScope.mappable`): the rule matches,
 * whether or not its target resolves.
 */
export function mapperTakes(
  state: Records,
  specifier: string,
  importer: string,
  kind: ResolveKind,
): boolean {
  if (state.options.moduleScope?.mappable?.includes(specifier) !== true) return false
  const result = state.options.resolver.resolve(specifier, {
    importer,
    kind,
    conditions: edgeConditions(state.edgeKinds, kind),
  })
  return (result.type === 'file' || result.type === 'not-found') && result.mappedBy !== null
}

/**
 * Resolves `specifier` from `importer` to a target; one that doesn't resolve is `missing`. The edge
 * resolves as the kind `ModulePolicy.edgeResolveKind` gives it from `kind` and its importer (a
 * mock call's specifier, `exact`, as `kind` itself: `ModulePolicy.mockResolveKind`).
 */
export function resolveOrMissing(
  state: Records,
  specifier: string,
  importer: string,
  written: ResolveKind,
  exact = false,
): Found | Extract<Target, { readonly kind: 'missing' | 'served' }> {
  const kind = exact ? written : edgeKind(state.edgeKinds, importer, written)
  // A module the dialect serves (`@jest/globals`) is never resolved or loaded: its edge reads the
  // scope's value first (`FileRegistry.#mockOf`), as Jest answers `@jest/globals` before the
  // mapper, the resolver and the mocks.
  if (
    state.options.moduleScope?.modules?.includes(specifier) === true &&
    !mapperTakes(state, specifier, importer, kind)
  ) {
    return {
      kind: 'served',
      get error() {
        return notFound(state, specifier, importer, kind)
      },
    }
  }
  // A `data:` URL names its own source: nothing to resolve (`recordFor` decodes it).
  if (specifier.startsWith(DATA)) return { kind: 'user', id: toModuleId(specifier) }
  // A package with no entry for the importer's kind (an `import`-only one) is `missing`, as in
  // Jest, so a virtual mock or a mapper can still stand in for it.
  const result = state.options.resolver.resolve(specifier, {
    importer,
    kind,
    conditions: edgeConditions(state.edgeKinds, kind),
  })
  if (result.type === 'builtin') return { kind: 'builtin', id: result.id }
  if (result.type === 'file') {
    if (result.format === 'addon' || isExternal(state, result.path)) {
      return { kind: 'external', path: result.path }
    }
    return { kind: 'user', id: toModuleId(result.path) }
  }
  return {
    kind: 'missing',
    error: notFound(
      state,
      specifier,
      importer,
      kind,
      result.type === 'not-found' ? result : undefined,
    ),
  }
}

/** Resolves `specifier` from `importer` to a target, or throws `ERR_MODULE_NOT_FOUND` (`MODULE_NOT_FOUND` for `require`). */
export function resolveTarget(
  state: Records,
  specifier: string,
  importer: string,
  kind: ResolveKind,
): Found {
  const target = resolveOrMissing(state, specifier, importer, kind)
  if (target.kind === 'missing' || target.kind === 'served') throw target.error
  return target
}

/**
 * The target behind an id the module-mock registry hands back (`loadActual`): `node:<name>` is a
 * builtin, a path under `node_modules` that `inline` doesn't match and no transform takes (or an
 * addon) is an external, any other path a user module.
 */
export function targetOfId(state: Records, id: string): Found {
  if (id.startsWith('node:')) return { kind: 'builtin', id }
  if (isExternal(state, id)) return { kind: 'external', path: id }
  return { kind: 'user', id: toModuleId(id) }
}

/**
 * The edges of the user module at `path` as the loader holds them: its static deps (and the late
 * ones) resolved from it, as an edge would. `null` when its file does not compile. Used to follow
 * a closure of node_modules files through a workspace package linked into them (T2.6).
 */
export function userEdgesOf(state: Records, path: string): readonly GraphEdge[] | null {
  let record: ModuleRecord
  try {
    record = recordFor(state, toModuleId(path), false)
  } catch {
    return null
  }
  const kind = record.format === 'cjs' ? 'require' : 'import'
  return [...record.deps, ...record.lateDeps].map((specifier): GraphEdge => {
    let target: string | null = null
    try {
      const found = resolveOrMissing(state, specifier, path, kind)
      if (found.kind === 'user') target = found.id
      else if (found.kind === 'external') target = found.path
      else if (found.kind === 'builtin') target = found.id
    } catch {
      // A resolver that throws leaves the edge unresolved, as the graph's own would.
    }
    return { specifier, kind, target }
  })
}

/** The key of an external or builtin in `externals` and `required`. */
export function externalKey(target: Target): string {
  if (target.kind === 'builtin') return target.id
  if (target.kind === 'external') return target.path
  throw new Error(`${target.kind} is not an external`)
}

/** Transforms a user module once per worker. */
export function recordFor(state: Records, id: ModuleId, isTest: boolean): ModuleRecord {
  const existing = state.records.get(id)
  if (existing !== undefined) return existing
  const path = fileOf(id)
  // A `data:` URL is a user module whose source is the URL itself: evaluated per registry, as
  // jest-runtime evaluates one per test file, where Node's own `import()` shares it (compat).
  const data = path.startsWith(DATA) ? dataSource(path) : null
  const text = data === null ? readFileSync(path, 'utf8') : data.text
  // What the transforms see: a data: module is JavaScript, named as a module in the root.
  const filename = data === null ? path : join(state.options.root, '[data].mjs')
  // A node_modules file only gets here when a mock made it inline (T2.6), a transform takes it
  // (B23e), or `inline` names it.
  const thirdParty = isThirdParty(path, state.inlineRules)
  let record: ModuleRecord
  let transformKeyOf = ''
  if (data?.json === true || path.endsWith('.json')) {
    record = makeRecord(id, path, 'json', text, () => null, [], [], false, false)
  } else if (/\.(?:wasm|node)$/.test(path)) {
    throw new LoaderError('LOADER_UNSUPPORTED_MODULE', `cannot load ${path} as a user module`)
  } else {
    const transformed = state.options.transformer.transform({
      filename,
      source: text,
      role: thirdParty ? 'dependency' : isTest ? 'test' : 'source',
      consumer: 'import',
      instrument: state.options.shouldInstrument?.(path) === true,
    })
    transformKeyOf = transformed.cacheKey
    const error = transformed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (error?.thrown !== undefined) {
      // A hosted transformer threw: its own error is what the file fails with, the class it threw
      // as the name (a thrown string has none) and its message as it was, which already names the file.
      const message =
        loaderMessage(state.options.policy, 'transformer-failed', {
          file: path,
          message: error.message,
        }) ?? error.message
      const failure = new LoaderError(
        'LOADER_TRANSFORM_FAILED',
        error.codeFrame === undefined ? message : `${message}\n\n${error.codeFrame}`,
      )
      failure.name = error.thrown.name ?? 'Error'
      throw failure
    }
    if (error !== undefined) {
      const where = error.loc === undefined ? '' : `:${error.loc.line}:${error.loc.column}`
      const message =
        loaderMessage(state.options.policy, 'transform-failed', {
          file: path,
          where,
          message: error.message,
        }) ?? `${path}${where}: ${error.message}`
      throw new LoaderError(
        'LOADER_TRANSFORM_FAILED',
        error.codeFrame === undefined ? message : `${message}\n\n${error.codeFrame}`,
      )
    }
    // A file whose only module syntax is `import()` has no static form (`unknown`), and `import()`
    // fails in a CommonJS `vm` script, so it runs in module form (B13c Gap 6).
    if (usesModuleRunnerForm(transformed)) {
      const runner = toModuleRunner(filename, transformed)
      record = makeRecord(
        id,
        path,
        'esm',
        runner.code,
        () => runner.map,
        runner.deps,
        transformed.lateDeps,
        transformed.hasTopLevelAwait,
        thirdParty,
      )
    } else {
      const requires = transformed.imports
        .filter((entry) => entry.kind === 'require')
        .map((entry) => entry.specifier)
      // A CommonJS file that calls `import()` keeps its CommonJS form with the call rewritten to a
      // binding the wrapper takes (`ModuleRecord.dynamicImport`); the runner form of a CommonJS
      // file is that rewrite and nothing else.
      const dynamicImport = transformed.imports.some((entry) => entry.kind === 'dynamic')
      const source = dynamicImport
        ? toModuleRunner(filename, transformed, { commonjs: true })
        : transformed
      record = makeRecord(
        id,
        path,
        'cjs',
        source.code,
        () => source.map,
        requires,
        [],
        false,
        thirdParty,
        dynamicImport,
      )
    }
  }
  if (record.format !== 'json') record.transformKey = transformKeyOf
  state.records.set(id, record)
  // A record that already names this id (a target resolved before its module was transformed, or a
  // module dropped and made again) now has a dep to read.
  const importers = state.importers.get(id)
  if (importers !== undefined) for (const importer of importers) state.graphsDirty.add(importer)
  return record
}

function makeRecord(
  id: ModuleId,
  path: string,
  format: UserFormat,
  source: string,
  mapOf: () => SourceMapV3 | null,
  deps: readonly string[],
  lateDeps: readonly string[],
  hasTopLevelAwait: boolean,
  thirdParty: boolean,
  dynamicImport = false,
): ModuleRecord {
  return {
    id,
    path,
    format,
    source,
    get map() {
      return mapOf()
    },
    deps,
    lateDeps,
    hasTopLevelAwait,
    thirdParty,
    dynamicImport,
    asyncGraph: hasTopLevelAwait,
    lateGraph: lateDeps.length > 0,
    resolved: new Map(),
    linked: false,
    compiledSync: null,
    compiledAsync: null,
    scope: null,
    transformKey: '',
    wrapperLength: null,
  }
}

/**
 * Preloads a shared external natively with `import()`, for the async path under `interopDefault:
 * 'node'` (Node's own namespaces). Under `babel` nothing is preloaded: the edge `require`s the
 * external when it runs, as Jest's CommonJS output does, so a mocked package never loads.
 */
export async function preloadAsync(state: Records, target: Target): Promise<void> {
  if (target.kind !== 'external' && target.kind !== 'builtin') return
  if (state.options.policy.interopDefault !== 'node') return
  const key = externalKey(target)
  if (state.externals.has(key)) return
  const specifier = target.kind === 'builtin' ? target.id : pathToFileURL(target.path).href
  const namespace: object = await import(specifier)
  state.externals.set(key, namespace)
}

/**
 * One dep of `record` at link time: its target, with a user module transformed (and queued on
 * `stack`) or, when it doesn't transform, recorded `failed`. A mocked module is never evaluated,
 * so its transform error only matters if the edge decides on the real module.
 */
function linkDep(
  state: Records,
  record: ModuleRecord,
  specifier: string,
  stack: ModuleRecord[],
): Target {
  let target: Target = resolveOrMissing(
    state,
    specifier,
    record.path,
    record.format === 'cjs' ? 'require' : 'import',
  )
  if (target.kind === 'user') {
    try {
      stack.push(recordFor(state, target.id, false))
    } catch (error) {
      target = { kind: 'failed', id: target.id, error }
    }
  }
  setResolved(state, record, specifier, target)
  return target
}

/**
 * Links a module's static subgraph (Track 2 R1 step 2): resolve every dep, transform user modules,
 * and preload externals the ESM code imports. A dep that doesn't resolve is recorded `missing`, one
 * that doesn't transform `failed`; each fails only when its edge runs. Late deps are not linked:
 * the mocks register first.
 */
export async function linkAsync(state: Records, root: ModuleRecord): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    const record = stack.pop()
    if (record === undefined || record.linked) continue
    record.linked = true
    for (const specifier of record.deps) {
      const target = linkDep(state, record, specifier, stack)
      if (record.format === 'esm') await preloadAsync(state, target)
    }
  }
  markAsyncGraphs(state)
}

export function linkSync(state: Records, root: ModuleRecord): void {
  const stack = [root]
  while (stack.length > 0) {
    const record = stack.pop()
    if (record === undefined || record.linked) continue
    record.linked = true
    for (const specifier of record.deps) linkDep(state, record, specifier, stack)
  }
  markAsyncGraphs(state)
}

/**
 * Sets `specifier`'s target on `record`. The only writer of `resolved`, so it can keep the
 * importers index and mark `record` for `markAsyncGraphs`.
 */
export function setResolved(
  state: Records,
  record: ModuleRecord,
  specifier: string,
  target: Target,
): void {
  record.resolved.set(specifier, target)
  if (target.kind !== 'user') return
  let importers = state.importers.get(target.id)
  if (importers === undefined) {
    importers = new Set()
    state.importers.set(target.id, importers)
  }
  importers.add(record)
  state.graphsDirty.add(record)
}

/**
 * Marks every module whose static subgraph has top-level await (`asyncGraph`) or late deps
 * (`lateGraph`), to a fixed point over cycles.
 *
 * Incremental: only the records whose inputs changed since the last run (`Records.graphsDirty`: a
 * `user` target written to `resolved`, which every link of a dep goes through, and the importers of
 * a module whose record was made) are looked at, and a record that gains a
 * flag puts its importers (`Records.importers`) on the worklist, so a run costs the edges around
 * what changed, not every record in the worker. The result is the one a scan of every record to a
 * fixed point gives: the flags only ever go from `false` to `true`, a linked record takes a flag
 * when a `user` target's live record has it, and a record whose inputs did not change already
 * satisfies that from the last run. A record that is no longer the live one for its id is never
 * looked at: `dropRecords` takes it out of the dirty set and the importers index.
 */
function markAsyncGraphs(state: Records): void {
  // The dirty set is the worklist: a record is taken out as it is looked at, and an importer put
  // back in is looked at again (a `Set` visits what is added while it is iterated). It is empty at
  // the end.
  const work = state.graphsDirty
  for (const record of work) {
    work.delete(record)
    if (!record.linked || (record.asyncGraph && record.lateGraph)) continue
    let changed = false
    for (const target of record.resolved.values()) {
      // A `missing` or `failed` target has no record: it adds nothing to the graph.
      const dep = target.kind === 'user' ? state.records.get(target.id) : undefined
      if (dep === undefined) continue
      if (dep.asyncGraph && !record.asyncGraph) {
        record.asyncGraph = true
        changed = true
      }
      if (dep.lateGraph && !record.lateGraph) {
        record.lateGraph = true
        changed = true
      }
    }
    if (changed) {
      const importers = state.importers.get(record.id)
      if (importers !== undefined) for (const importer of importers) work.add(importer)
    }
  }
}

/** The scope bindings `record`'s source names, found once. */
export function scopeOf(state: Records, record: ModuleRecord): readonly string[] {
  if (record.scope !== null) return record.scope
  const names = record.format === 'esm' ? state.scopeNames.esm : state.scopeNames.cjs
  record.scope =
    record.format === 'json'
      ? []
      : names.filter((name) => state.scopePatterns.get(name)?.test(record.source) === true)
  return record.scope
}

/**
 * A record's wrapper function for one evaluation in `mode`. The script is compiled once per worker
 * and mode (`wrapperScript`). `fresh` (an evaluation in a registry of one file) runs it again for a
 * new function; otherwise (a registry shared across files, which evaluates a module once) the
 * function of its first run is called again.
 *
 * Why fresh: V8 keeps a function's feedback (its inline caches, and the optimized code built on
 * them) in a cell its closure shares with every closure the same enclosing function object made. A
 * module evaluated in every file through one wrapper function would give every file's copy of its
 * functions one feedback vector, and each file's new classes (new hidden classes) would add maps to
 * the same inline caches until they went megamorphic. A new run of the script makes a new wrapper
 * with feedback of its own, as Jest's compile of each module for every test file does, at the cost
 * of one script run and of each file's copy warming up again, as it does in Jest
 * (`pnpm bench:loader megamorphic` shows what the shared feedback cost).
 */
export function compile(
  state: Records,
  record: ModuleRecord,
  mode: 'sync' | 'async',
  fresh: boolean,
): Compiled {
  const wrapper = wrapperScript(state, record, mode)
  if (fresh) return runWrapper(wrapper.script, record)
  wrapper.shared ??= runWrapper(wrapper.script, record)
  return wrapper.shared
}

function runWrapper(script: Script, record: ModuleRecord): Compiled {
  const compiled: unknown = script.runInThisContext()
  if (typeof compiled !== 'function')
    throw new Error(`the wrapper for ${record.path} is not a function`)
  return compiled as Compiled
}

/**
 * Compiles a record's wrapper script once per worker and mode (filename = the real path, for
 * stacks and coverage), and reports it to the compile listeners then, once. `sync` strips the
 * `await` from the import calls, which only the sync path may do; `async` keeps them. A module
 * with scope bindings gets an outer function taking them, so a module's own `const require = …`
 * shadows the binding instead of clashing with a parameter.
 */
function wrapperScript(
  state: Records,
  record: ModuleRecord,
  mode: 'sync' | 'async',
): WrapperScript {
  const cached = mode === 'sync' ? record.compiledSync : record.compiledAsync
  if (cached !== null) return cached
  const scope = scopeOf(state, record)
  // A hashbang is legal only at the start of a script or module, and the wrapper puts the body
  // inside a function, so it becomes a line comment of the same length: columns and the map hold.
  let body = blankHashbang(record.source)
  let inner: string
  let head = ''
  if (record.format === 'esm') {
    if (mode === 'sync') {
      // Spaces in place of the `await`, not a removal: every column, and so every V8 coverage
      // offset, is the same in both modes (B23b, T2.9).
      body = body
        .replaceAll('await __vite_ssr_import__(', '      __vite_ssr_import__(')
        .replaceAll(`await ${LATE_IMPORT}(`, `      ${LATE_IMPORT}(`)
    }
    head = "'use strict';"
    inner = `${mode === 'async' ? 'async ' : '      '}function (${ESM_PARAMS}) {`
  } else {
    inner = `function (${CJS_PARAMS}${record.dynamicImport ? `, ${DYNAMIC_IMPORT}` : ''}) {`
  }
  const prefix =
    scope.length === 0
      ? `${head}(${inner}`
      : `${head}(function (${scope.join(', ')}) { return ${inner}`
  const suffix = scope.length === 0 ? '\n})' : '\n}})'
  // The wrapper opens on the body's first line; the offset takes it back out of that line's
  // columns, so every frame is a position in the body, which is what the record's map reads.
  const code = `${prefix}${body}${suffix}`
  // The id, not the file: two URLs of one file are two scripts, each with its own coverage and map.
  const options = { filename: record.id, columnOffset: -prefix.length }
  const wrapper: WrapperScript = {
    // With a code cache, from V8's data for exactly this text when an earlier worker left it
    // (the key is a hash of the text, the filename and the offset).
    script:
      state.codeCache === null ? new Script(code, options) : state.codeCache.compile(code, options),
    shared: null,
  }
  if (mode === 'sync') record.compiledSync = wrapper
  else record.compiledAsync = wrapper
  record.wrapperLength = prefix.length
  for (const listener of state.listeners) {
    listener({
      id: record.id,
      scriptUrl: record.id,
      wrapperColumnOffset: prefix.length,
      get map() {
        return record.map
      },
      thirdParty: record.thirdParty,
      transformKey: record.transformKey,
    })
  }
  return wrapper
}

/**
 * Forgets the records of these modules (absolute paths), so the next load reads and compiles them
 * again. Watch mode's stale modules (B23c). A path with no record is skipped. The flags of the
 * records that pointed at one stay (they only ever rise, as before); the record made next marks its
 * importers for `markAsyncGraphs`.
 */
export function dropRecords(state: Records, paths: readonly string[]): void {
  for (const path of paths) {
    const id = toModuleId(path)
    const record = state.records.get(id)
    if (record === undefined) continue
    state.records.delete(id)
    // As an importer it is gone; its own importers keep their entry, for the record made next.
    for (const target of record.resolved.values()) {
      if (target.kind === 'user') state.importers.get(target.id)?.delete(record)
    }
    state.graphsDirty.delete(record)
  }
}
