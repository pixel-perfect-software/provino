// The worker-wide half of the engine (Track 2 R1 steps 1–2): each user module is transformed and
// compiled once per worker, its static deps are resolved once, and shared externals are loaded
// natively. Records never hold per-file state; that lives in a registry's instances.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { toModuleRunner } from '@provino/transform'
import type {
  CompiledModuleEvent,
  LoaderOptions,
  ModuleId,
  ResolveKind,
  SourceMapV3,
} from '@provino/types'
import { LoaderError } from '../errors.ts'

/** Where a specifier leads. */
export type Target =
  | { readonly kind: 'user'; readonly id: ModuleId }
  | { readonly kind: 'external'; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: string }

export type UserFormat = 'esm' | 'cjs' | 'json'

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
  readonly hasTopLevelAwait: boolean
  /** Its static subgraph has top-level await, so it evaluates with the async wrapper. */
  asyncGraph: boolean
  readonly resolved: Map<string, Target>
  linked: boolean
  compiled: ((...args: unknown[]) => unknown) | null
}

/** The wrapper parameters, in order. ESM gets Vite's linkers; CJS gets Node's wrapper. */
const ESM_PARAMS =
  '__vite_ssr_exports__, __vite_ssr_import_meta__, __vite_ssr_import__, __vite_ssr_dynamic_import__, __vite_ssr_exportAll__'
const CJS_PARAMS = 'exports, require, module, __filename, __dirname'

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
  /** Native namespaces of shared externals and builtins, by path or `node:` id. */
  readonly externals: Map<string, object>
  readonly listeners: Set<(event: CompiledModuleEvent) => void>
  /**
   * Whether anything `markAsyncGraphs` reads has changed since it last ran: a new record, a record
   * linked, a resolved target. It is on the state, not in a walk, so a walk that throws partway
   * leaves it set for the next call. A link that changes nothing (every cached `require`) skips the
   * scan of every record in the worker.
   */
  asyncGraphsStale: boolean
}

export function createRecords(options: LoaderOptions): Records {
  return {
    options,
    records: new Map(),
    externals: new Map(),
    listeners: new Set(),
    asyncGraphsStale: false,
  }
}

/** Resolves `specifier` from `importer` to a target, or throws `ERR_MODULE_NOT_FOUND`. */
export function resolveTarget(
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
  throw new LoaderError(
    'ERR_MODULE_NOT_FOUND',
    `Cannot find module '${specifier}' imported from ${importer}`,
  )
}

/** Transforms a user module once per worker. */
export function recordFor(state: Records, id: ModuleId, isTest: boolean): ModuleRecord {
  const existing = state.records.get(id)
  if (existing !== undefined) return existing
  const path: string = id
  const text = readFileSync(path, 'utf8')
  let record: ModuleRecord
  if (path.endsWith('.json')) {
    record = makeRecord(id, 'json', text, null, [], false)
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
      throw new LoaderError(
        'LOADER_TRANSFORM_FAILED',
        `${path}${where}: ${error.message}${error.codeFrame === undefined ? '' : `\n${error.codeFrame}`}`,
      )
    }
    if (transformed.format === 'esm') {
      const runner = toModuleRunner(path, transformed)
      record = makeRecord(
        id,
        'esm',
        runner.code,
        runner.map,
        runner.deps,
        transformed.hasTopLevelAwait,
      )
    } else {
      const requires = transformed.imports
        .filter((entry) => entry.kind === 'require')
        .map((entry) => entry.specifier)
      record = makeRecord(id, 'cjs', transformed.code, transformed.map, requires, false)
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
  hasTopLevelAwait: boolean,
): ModuleRecord {
  return {
    id,
    path: id,
    format,
    source,
    map,
    deps,
    hasTopLevelAwait,
    asyncGraph: hasTopLevelAwait,
    resolved: new Map(),
    linked: false,
    compiled: null,
  }
}

/** A CJS external's namespace for an ESM import, when it can't come from native `import()`. */
function cjsNamespace(exports: unknown): object {
  const namespace: Record<string, unknown> = Object.create(null)
  if (exports !== null && (typeof exports === 'object' || typeof exports === 'function')) {
    for (const key of Object.keys(exports)) {
      if (key !== 'default') namespace[key] = Reflect.get(exports, key)
    }
  }
  namespace.default = exports
  return namespace
}

/** Loads a shared external natively: `import()` when async, `require` (and `require(esm)`) when sync. */
async function preloadAsync(state: Records, target: Target): Promise<void> {
  if (target.kind === 'user') return
  const key = target.kind === 'builtin' ? target.id : target.path
  if (state.externals.has(key)) return
  const specifier = target.kind === 'builtin' ? target.id : pathToFileURL(target.path).href
  const namespace: object = await import(specifier)
  state.externals.set(key, namespace)
}

function preloadSync(state: Records, target: Target, from: string): void {
  if (target.kind === 'user') return
  const key = target.kind === 'builtin' ? target.id : target.path
  if (state.externals.has(key)) return
  const loaded: unknown = createRequire(from)(key)
  const esModule =
    loaded !== null &&
    typeof loaded === 'object' &&
    Reflect.get(loaded, Symbol.toStringTag) === 'Module'
  state.externals.set(key, esModule ? (loaded as object) : cjsNamespace(loaded))
}

/**
 * Links a module's static subgraph (Track 2 R1 step 2): resolve every dep, transform user modules,
 * and preload externals the ESM code imports. `mode: 'sync'` serves `require()`.
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
      const target = resolveTarget(state, specifier, record.path, kind)
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
      const target = resolveTarget(state, specifier, record.path, kind)
      setResolved(state, record, specifier, target)
      if (target.kind === 'user') stack.push(recordFor(state, target.id, false))
      else if (record.format === 'esm') preloadSync(state, target, record.path)
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

/** Compiles a record's wrapper once per worker (filename = the real path, for stacks and coverage). */
export function compile(state: Records, record: ModuleRecord): (...args: unknown[]) => unknown {
  if (record.compiled !== null) return record.compiled
  let prefix: string
  let body = record.source
  if (record.format === 'esm') {
    if (!record.asyncGraph)
      body = body.replaceAll('await __vite_ssr_import__(', '__vite_ssr_import__(')
    prefix = `'use strict';(${record.asyncGraph ? 'async ' : ''}function (${ESM_PARAMS}) {`
  } else {
    prefix = `(function (${CJS_PARAMS}) {`
  }
  const compiled: unknown = runInThisContext(`${prefix}${body}\n})`, { filename: record.path })
  if (typeof compiled !== 'function')
    throw new Error(`the wrapper for ${record.path} is not a function`)
  record.compiled = compiled as (...args: unknown[]) => unknown
  for (const listener of state.listeners) {
    listener({
      id: record.id,
      scriptUrl: record.path,
      wrapperColumnOffset: prefix.length,
      map: record.map,
      thirdParty: false,
    })
  }
  return record.compiled
}
