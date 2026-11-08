// The worker-wide half of the engine (Track 2 R1 steps 1–2): each user module is transformed and
// compiled once per worker, its static deps are resolved once, and shared externals are loaded
// natively. Records never hold per-file state; that lives in a registry's instances.
import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { LATE_IMPORT, toModuleRunner } from '@provino/transform'
import type {
  CompiledModuleEvent,
  LoaderOptions,
  ModuleId,
  ResolveKind,
  SourceMapV3,
} from '@provino/types'
import { LoaderError, ModuleNotFoundError } from '../errors.ts'
import { loaderMessage } from './messages.ts'

/**
 * Where a specifier leads. `missing` is a specifier that doesn't resolve: recorded when the graph
 * is linked and thrown only when the edge runs, after the mock registry had its say (a `virtual`
 * mock, `try { require('optional') } catch {}`; B13c Gap 7).
 */
export type Target =
  | { readonly kind: 'user'; readonly id: ModuleId }
  | { readonly kind: 'external'; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: string }
  | { readonly kind: 'missing'; readonly error: ModuleNotFoundError }

export type UserFormat = 'esm' | 'cjs' | 'json'

/** A compiled wrapper. With scope bindings it is the outer function, which returns the wrapper. */
export type Compiled = (...args: unknown[]) => unknown

/** One user module, as every registry in the worker shares it. */
export interface ModuleRecord {
  readonly id: ModuleId
  readonly path: string
  readonly format: UserFormat
  /** The wrapper source, or the JSON text. */
  readonly source: string
  readonly map: SourceMapV3 | null
  /** Static deps: import specifiers (ESM) or literal `require` specifiers (CJS). */
  readonly deps: readonly string[]
  /** Imports the hoister made late (D38): never linked ahead, loaded when their call runs. */
  readonly lateDeps: readonly string[]
  readonly hasTopLevelAwait: boolean
  /** Its static subgraph has top-level await, so it evaluates with the async wrapper. */
  asyncGraph: boolean
  readonly resolved: Map<string, Target>
  linked: boolean
  /** The plain wrapper (`await` stripped from its import calls) and the async one, each compiled on first use. */
  compiledSync: Compiled | null
  compiledAsync: Compiled | null
  /**
   * The scope bindings this module's source names, in the worker's order (B13c Gap 2): the
   * dialect's per-module names, and for ES modules under `injectCjsGlobals` `require`,
   * `__filename` and `__dirname`. Found by a word scan at the first compile; a module that names
   * none gets no outer function and pays nothing.
   */
  scope: readonly string[] | null
}

/** The wrapper parameters, in order. ESM gets Vite's linkers and the late import; CJS gets Node's wrapper. */
const ESM_PARAMS = `__vite_ssr_exports__, __vite_ssr_import_meta__, __vite_ssr_import__, __vite_ssr_dynamic_import__, __vite_ssr_exportAll__, ${LATE_IMPORT}`
const CJS_PARAMS = 'exports, require, module, __filename, __dirname'
/** What an ES module gets under `ModulePolicy.injectCjsGlobals`, when its source names them. */
const CJS_GLOBALS: readonly string[] = ['require', '__filename', '__dirname']

export function toModuleId(path: string): ModuleId {
  return path as ModuleId
}

function isThirdParty(path: string, inline: readonly (string | RegExp)[]): boolean {
  if (!/[\\/]node_modules[\\/]/.test(path)) return false
  return !inline.some((rule) =>
    typeof rule === 'string' ? path.includes(`/node_modules/${rule}/`) : rule.test(path),
  )
}

export interface Records {
  readonly options: LoaderOptions
  readonly records: Map<ModuleId, ModuleRecord>
  /** Native namespaces of shared externals and builtins (`import()`), by path or `node:` id. */
  readonly externals: Map<string, object>
  /** Natively required values of shared externals and builtins, by path or `node:` id. */
  readonly required: Map<string, unknown>
  readonly listeners: Set<(event: CompiledModuleEvent) => void>
  /** The scope names a module of each format can be given, in order. */
  readonly scopeNames: { readonly esm: readonly string[]; readonly cjs: readonly string[] }
  /** One word-scan pattern per scope name. */
  readonly scopePatterns: ReadonlyMap<string, RegExp>
  /**
   * Whether anything `markAsyncGraphs` reads has changed since it last ran: a new record, a record
   * linked, a resolved target. It is on the state, not in a walk, so a walk that throws partway
   * leaves it set for the next call. A link that changes nothing (every cached `require`) skips the
   * scan of every record in the worker.
   */
  asyncGraphsStale: boolean
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createRecords(options: LoaderOptions): Records {
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
  return {
    options,
    records: new Map(),
    externals: new Map(),
    required: new Map(),
    listeners: new Set(),
    scopeNames: { esm, cjs: dialect },
    scopePatterns,
    asyncGraphsStale: false,
  }
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
): ModuleNotFoundError {
  const from = relative(state.options.root, importer).split(sep).join('/')
  const message =
    loaderMessage(state.options.policy, 'module-not-found', { specifier, from, importer }) ??
    `Cannot find module '${specifier}' imported from ${importer}`
  return new ModuleNotFoundError(
    kind === 'require' ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND',
    message,
  )
}

/** Resolves `specifier` from `importer` to a target; one that doesn't resolve is `missing`. */
export function resolveOrMissing(
  state: Records,
  specifier: string,
  importer: string,
  kind: ResolveKind,
): Target {
  const result = state.options.resolver.resolve(specifier, {
    importer,
    kind,
    conditions: state.options.conditions ?? ['node'],
  })
  if (result.type === 'builtin') return { kind: 'builtin', id: result.id }
  if (result.type === 'file') {
    if (result.format === 'addon' || isThirdParty(result.path, state.options.inline ?? [])) {
      return { kind: 'external', path: result.path }
    }
    return { kind: 'user', id: toModuleId(result.path) }
  }
  return { kind: 'missing', error: notFound(state, specifier, importer, kind) }
}

/** Resolves `specifier` from `importer` to a target, or throws `ERR_MODULE_NOT_FOUND` (`MODULE_NOT_FOUND` for `require`). */
export function resolveTarget(
  state: Records,
  specifier: string,
  importer: string,
  kind: ResolveKind,
): Exclude<Target, { kind: 'missing' }> {
  const target = resolveOrMissing(state, specifier, importer, kind)
  if (target.kind === 'missing') throw target.error
  return target
}

/**
 * The target behind an id the module-mock registry hands back (`loadActual`): `node:<name>` is a
 * builtin, a path under `node_modules` that `inline` doesn't match (or an addon) is an external,
 * any other path a user module.
 */
export function targetOfId(state: Records, id: string): Exclude<Target, { kind: 'missing' }> {
  if (id.startsWith('node:')) return { kind: 'builtin', id }
  if (id.endsWith('.node') || isThirdParty(id, state.options.inline ?? [])) {
    return { kind: 'external', path: id }
  }
  return { kind: 'user', id: toModuleId(id) }
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
  const path: string = id
  const text = readFileSync(path, 'utf8')
  let record: ModuleRecord
  if (path.endsWith('.json')) {
    record = makeRecord(id, 'json', text, null, [], [], false)
  } else if (/\.(?:wasm|node)$/.test(path)) {
    throw new LoaderError('LOADER_UNSUPPORTED_MODULE', `cannot load ${path} as a user module`)
  } else {
    const transformed = state.options.transformer.transform({
      filename: path,
      source: text,
      role: isTest ? 'test' : 'source',
      consumer: 'import',
      instrument: false,
    })
    const error = transformed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
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
    const esm =
      transformed.format === 'esm' ||
      (transformed.format === 'unknown' &&
        transformed.imports.some((entry) => entry.kind === 'dynamic'))
    if (esm) {
      const runner = toModuleRunner(path, transformed)
      record = makeRecord(
        id,
        'esm',
        runner.code,
        runner.map,
        runner.deps,
        transformed.lateDeps,
        transformed.hasTopLevelAwait,
      )
    } else {
      const requires = transformed.imports
        .filter((entry) => entry.kind === 'require')
        .map((entry) => entry.specifier)
      record = makeRecord(id, 'cjs', transformed.code, transformed.map, requires, [], false)
    }
  }
  state.records.set(id, record)
  state.asyncGraphsStale = true
  return record
}

function makeRecord(
  id: ModuleId,
  format: UserFormat,
  source: string,
  map: SourceMapV3 | null,
  deps: readonly string[],
  lateDeps: readonly string[],
  hasTopLevelAwait: boolean,
): ModuleRecord {
  return {
    id,
    path: id,
    format,
    source,
    map,
    deps,
    lateDeps,
    hasTopLevelAwait,
    asyncGraph: hasTopLevelAwait,
    resolved: new Map(),
    linked: false,
    compiledSync: null,
    compiledAsync: null,
    scope: null,
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
 * Links a module's static subgraph (Track 2 R1 step 2): resolve every dep, transform user modules,
 * and preload externals the ESM code imports. A dep that doesn't resolve is recorded `missing`
 * and fails only when its edge runs. Late deps are not linked: the mocks register first.
 */
export async function linkAsync(state: Records, root: ModuleRecord): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    const record = stack.pop()
    if (record === undefined || record.linked) continue
    record.linked = true
    state.asyncGraphsStale = true
    const kind: ResolveKind = record.format === 'cjs' ? 'require' : 'import'
    for (const specifier of record.deps) {
      const target = resolveOrMissing(state, specifier, record.path, kind)
      setResolved(state, record, specifier, target)
      if (target.kind === 'user') stack.push(recordFor(state, target.id, false))
      else if (record.format === 'esm') await preloadAsync(state, target)
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
    state.asyncGraphsStale = true
    const kind: ResolveKind = record.format === 'cjs' ? 'require' : 'import'
    for (const specifier of record.deps) {
      const target = resolveOrMissing(state, specifier, record.path, kind)
      setResolved(state, record, specifier, target)
      if (target.kind === 'user') stack.push(recordFor(state, target.id, false))
    }
  }
  markAsyncGraphs(state)
}

/** Sets `specifier`'s target on `record`. The only writer of `resolved`, so it can mark the state stale. */
export function setResolved(
  state: Records,
  record: ModuleRecord,
  specifier: string,
  target: Target,
): void {
  record.resolved.set(specifier, target)
  state.asyncGraphsStale = true
}

/**
 * Marks every module whose static subgraph has top-level await, to a fixed point over cycles.
 * A no-op unless something it reads has changed since the last run, so it is safe to call after
 * every link.
 */
function markAsyncGraphs(state: Records): void {
  if (!state.asyncGraphsStale) return
  state.asyncGraphsStale = false
  let changed = true
  while (changed) {
    changed = false
    for (const record of state.records.values()) {
      if (record.asyncGraph || !record.linked) continue
      for (const target of record.resolved.values()) {
        if (target.kind === 'user' && state.records.get(target.id)?.asyncGraph === true) {
          record.asyncGraph = true
          changed = true
          break
        }
      }
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
 * Compiles a record's wrapper once per worker and mode (filename = the real path, for stacks and
 * coverage). `sync` strips the `await` from the import calls, which only the sync path may do;
 * `async` keeps them. A module with scope bindings gets an outer function taking them, so a
 * module's own `const require = …` shadows the binding instead of clashing with a parameter.
 */
export function compile(state: Records, record: ModuleRecord, mode: 'sync' | 'async'): Compiled {
  const cached = mode === 'sync' ? record.compiledSync : record.compiledAsync
  if (cached !== null) return cached
  const scope = scopeOf(state, record)
  let body = record.source
  let inner: string
  let head = ''
  if (record.format === 'esm') {
    if (mode === 'sync') {
      body = body
        .replaceAll('await __vite_ssr_import__(', '__vite_ssr_import__(')
        .replaceAll(`await ${LATE_IMPORT}(`, `${LATE_IMPORT}(`)
    }
    head = "'use strict';"
    inner = `${mode === 'async' ? 'async ' : ''}function (${ESM_PARAMS}) {`
  } else {
    inner = `function (${CJS_PARAMS}) {`
  }
  const prefix =
    scope.length === 0
      ? `${head}(${inner}`
      : `${head}(function (${scope.join(', ')}) { return ${inner}`
  const suffix = scope.length === 0 ? '\n})' : '\n}})'
  const compiled: unknown = runInThisContext(`${prefix}${body}${suffix}`, { filename: record.path })
  if (typeof compiled !== 'function')
    throw new Error(`the wrapper for ${record.path} is not a function`)
  const fn = compiled as Compiled
  if (mode === 'sync') record.compiledSync = fn
  else record.compiledAsync = fn
  for (const listener of state.listeners) {
    listener({
      id: record.id,
      scriptUrl: record.path,
      wrapperColumnOffset: prefix.length,
      map: record.map,
      thirdParty: false,
    })
  }
  return fn
}
