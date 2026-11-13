// The per-file half of the engine (Track 2 R1 steps 3–4, F3): instances of the worker's records,
// evaluated synchronously unless something in their reach can make them wait. A registry never
// compiles or transforms; it calls the records' compiled wrappers with fresh linkers.
//
// Every edge (a static import, `require`, `import()`, and a late import, D38) resolves, then asks
// the running file's module-mock registry (T2.5 + T4.8): a mocked edge gets `materialize`'s value,
// shaped for the edge (`interop.ts`); any other gets the real module. With no module-mock registry,
// nothing is mocked and an edge costs what it did before B13c. The runner's own loads (a setup or
// test file, with no parent) never ask: that module itself is never mocked.
//
// An ES module loaded by `import` evaluates with the async wrapper when its graph has top-level
// await, when it reaches a module with late deps (a late dependency may itself await), or when a
// mocked edge can be pending (`awaitFactory`). Each wrapper passes its mode to its edges, so a sync
// edge never binds a Promise: it refuses with `ERR_REQUIRE_ASYNC_MODULE` instead.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleId, ModuleMockRegistry, ModuleScopeValues, ResolveKind } from '@provino/types'
import { LoaderError, ModuleNotFoundError } from '../errors.ts'
import { createLedger, mockedReach, noteInlined } from './inline.ts'
import { actualView, cjsNamespace, createInteropCache, esmExports } from './interop.ts'
import {
  type Compiled,
  compile,
  externalKey,
  type Found,
  linkAsync,
  linkSync,
  type ModuleRecord,
  preloadAsync,
  type Records,
  recordFor,
  resolveOrMissing,
  resolveTarget,
  scopeOf,
  setResolved,
  type Target,
  targetOfId,
  toModuleId,
  userEdgesOf,
} from './records.ts'

/** How the edge loads: `import` (a namespace) or `require` (the value itself). */
type Style = 'esm' | 'cjs'

/** How the module making the edge evaluates: a plain wrapper can't wait, an async one can. */
type Mode = 'sync' | 'async'

interface Instance {
  status: 'evaluating' | 'done' | 'errored'
  /** ESM: the exports object (`interop.ts`); JSON: its namespace. `null` for CJS. */
  readonly exports: Record<string | symbol, unknown> | null
  /** CJS: the `module` object; `require()` returns its `exports`. */
  readonly module: { exports: unknown } | null
  promise: Promise<object> | null
  error: unknown
  /** The actual paths' view of an ES module's exports, built once. */
  view: object | null
}

/**
 * A mock's value that isn't ready (a factory's Promise under `awaitFactory`), kept apart from a
 * module whose own value is a Promise.
 */
class Pending {
  readonly promise: Promise<unknown>
  constructor(promise: Promise<unknown>) {
    this.promise = promise
  }
}

/** What the running file brings: its module-mock registry and its per-module bindings. */
export interface FileContext {
  /** `null`: nothing is mocked. */
  readonly mocks: ModuleMockRegistry | null
  readonly scope: ModuleScopeValues | null
}

/** No file's context: nothing is mocked, and a module that names a binding sees the global. */
export const NO_FILE: FileContext = Object.freeze({ mocks: null, scope: null })

/** Not mocked: the edge loads the real module. */
const REAL: unique symbol = Symbol('real')

function moduleNamespace(): Record<string | symbol, unknown> {
  const namespace: Record<string | symbol, unknown> = Object.create(null)
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })
  return namespace
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'then') === 'function'
  )
}

/** `__vite_ssr_exportAll__`: re-export every name except `default` that isn't already set. */
function exportAll(target: object, source: unknown): void {
  if (source === null || typeof source !== 'object') return
  for (const key in source) {
    if (key === 'default' || key in target) continue
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => Reflect.get(source, key),
    })
  }
}

/** A `require()` of something that can only be loaded asynchronously. */
function requireError(what: string, why: string): LoaderError {
  return new LoaderError('ERR_REQUIRE_ASYNC_MODULE', `require() cannot load ${what}: ${why}`)
}

/** A load inside a module evaluating synchronously, of something that can't be. */
function syncLoadError(what: string, why: string): LoaderError {
  return new LoaderError(
    'ERR_REQUIRE_ASYNC_MODULE',
    `${what} can't be loaded synchronously: ${why}`,
  )
}

/**
 * One stack of instance maps: the top is used; `isolateModules` pushes a fresh one and removes
 * that same map when it finishes, wherever it ended up in the stack. A scratch load (automock's
 * real load) has a map of its own, carried in its own async context, so a load running beside it
 * never shares it.
 */
export class Registry {
  readonly #state: Records
  readonly #maps: Map<ModuleId, Instance>[]
  /** Namespaces built for CommonJS values and mocks, one per value, as Babel caches its wildcard. */
  readonly #cache = createInteropCache()
  /** The scratch load's own instance map, in its async context; made on the first scratch load. */
  #scratch: AsyncLocalStorage<Map<ModuleId, Instance>> | null = null
  /** How many scratch loads are running: with none, `#instances` asks no async context. */
  #scratchLoads = 0
  /**
   * Whether each node_modules file was served shared (`false`) or inlined (`true`), per instance map
   * (T2.6, B13d Gap 3): a module already served keeps its instance, so a `doMock` that comes after
   * its first load doesn't change it, `resetModules` forgets it, and an `isolateModules` layer
   * decides afresh.
   */
  readonly #memory = new WeakMap<Map<ModuleId, Instance>, Map<string, boolean>>()
  /** What this file inlined, for the budget and `LeakReport.inlinedForMocks`. */
  #ledger = createLedger()
  /** The running file's context. Under `none` the registry is shared, and each file sets its own. */
  context: FileContext = NO_FILE
  /**
   * The user modules the running file asked for (under `none`, where the registry outlives the
   * file): a module an earlier file evaluated is found, not evaluated again, and is still one the
   * file loaded. `null` outside `beginFile`/`endFile`.
   */
  #touched: Set<ModuleId> | null = null
  /**
   * The user modules each module loaded through an edge its static deps don't name (a
   * `require(variable)`, a runtime `import()`), by importing module, noted while a file is being
   * counted (`#touched` is set). Under `none` a later file finds the importer evaluated, not
   * evaluated again, so what it loaded then is what `loadedByFile` follows for it.
   */
  readonly #dynamicLoads = new Map<ModuleId, Set<ModuleId>>()

  constructor(state: Records, base: Map<ModuleId, Instance> = new Map()) {
    this.#state = state
    this.#maps = [base]
  }

  get #instances(): Map<ModuleId, Instance> {
    if (this.#scratchLoads > 0) {
      const scratch = this.#scratch?.getStore()
      if (scratch !== undefined) return scratch
    }
    const top = this.#maps.at(-1)
    if (top === undefined) throw new Error('registry has no instance map')
    return top
  }

  get #interop() {
    return this.#state.options.policy.interopDefault
  }

  /** Whether a mocked edge may be a Promise to wait for (`awaitFactory`, with mocks in play). */
  get #mocksMayWait(): boolean {
    return this.#state.options.policy.awaitFactory && this.context.mocks !== null
  }

  loaded(): ModuleId[] {
    return [...new Set(this.#maps.flatMap((map) => [...map.keys()]))]
  }

  /** Starts counting the modules a file asks for (the shared registry of tier `none`). */
  beginFile(): void {
    this.#touched = new Set()
  }

  /** Stops counting; the next `beginFile` starts over. */
  endFile(): void {
    this.#touched = null
  }

  /**
   * What the file loaded, under `none`: the modules it asked for and, through each one's
   * dependency edges, the loaded modules those reach (an evaluated module's imports are part of
   * what the file needs, though the file didn't evaluate them). Over-approximate for a CommonJS
   * module, whose edges are its `require` calls as the scan sees them. Without `beginFile`, every
   * instance.
   */
  loadedByFile(): ModuleId[] {
    const touched = this.#touched
    if (touched === null) return this.loaded()
    const seen = new Set<ModuleId>(touched)
    const queue = [...touched]
    const reach = (target: ModuleId): void => {
      if (seen.has(target) || !this.#maps.some((map) => map.has(target))) return
      seen.add(target)
      queue.push(target)
    }
    for (let at = 0; at < queue.length; at++) {
      const id = queue[at]
      if (id === undefined) continue
      // The targets the record linked (every static dep, and a `require`'s specifier once it has
      // resolved), not a new resolve of each specifier: the walk runs once per file over every
      // module the file reaches.
      const record = this.#state.records.get(id)
      if (record !== undefined) {
        for (const target of record.resolved.values()) {
          if (target.kind === 'user') reach(target.id)
          else if (target.kind === 'external') reach(toModuleId(target.path))
        }
      }
      const loads = this.#dynamicLoads.get(id)
      if (loads !== undefined) for (const target of loads) reach(target)
    }
    return [...seen]
  }

  /**
   * Notes that `importer` loaded the user module `id` through an edge that can be dynamic. Only
   * while a file is counted: a registry of any other tier is the file's own and never asks.
   */
  #noteLoad(importer: string, id: ModuleId): void {
    if (this.#touched === null) return
    const key = toModuleId(importer)
    let loads = this.#dynamicLoads.get(key)
    if (loads === undefined) {
      loads = new Set()
      this.#dynamicLoads.set(key, loads)
    }
    loads.add(id)
  }

  /**
   * Empties every layer of the stack and keeps its depth, so an `isolateModules` call that is
   * still running removes its own (now empty) map when it finishes.
   */
  reset(): void {
    for (const map of this.#maps) {
      map.clear()
      this.#memory.delete(map)
    }
  }

  /** The modules this file inlined for its mocks, in the order they were. */
  inlined(): ModuleId[] {
    return [...this.#ledger.modules]
  }

  /**
   * Ends the file's inlining under `none`: the registry is shared and outlives the file, so the
   * inlined instances go and the next file sees the shared module, and so does what was
   * remembered. Any other tier's registry is the file's own and is reset instead.
   */
  dropInlined(): void {
    for (const map of this.#maps) {
      const served = this.#memory.get(map)
      if (served === undefined) continue
      for (const [path, inlined] of served) if (inlined) map.delete(toModuleId(path))
      this.#memory.delete(map)
    }
    this.#ledger = createLedger()
  }

  /**
   * Drops the live instance of the user module `specifier` resolves to from `importer`, so its
   * next import or require evaluates it again. The specifier is resolved as an `import` and as a
   * `require`, since a package's `exports` can map them to different files and either may be the
   * one that was loaded. Records stay (compiled code is shared), and so does every other
   * instance: the module's dependencies keep theirs. An external, a builtin, a module that was
   * never loaded or a specifier that doesn't resolve (for that kind) is a no-op; the import
   * itself reports the last one.
   */
  invalidate(specifier: string, importer: string): void {
    for (const kind of ['import', 'require'] as const) {
      const target = resolveOrMissing(this.#state, specifier, importer, kind)
      if (target.kind === 'user') this.#instances.delete(target.id)
    }
  }

  isolate<R>(fn: () => R): R {
    const map = this.#push()
    try {
      return fn()
    } finally {
      this.#remove(map)
    }
  }

  async isolateAsync<R>(fn: () => Promise<R>): Promise<R> {
    const map = this.#push()
    try {
      return await fn()
    } finally {
      this.#remove(map)
    }
  }

  #push(): Map<ModuleId, Instance> {
    const map = new Map<ModuleId, Instance>()
    this.#maps.push(map)
    return map
  }

  /** Removes `map` itself, not whatever is on top: isolated calls can overlap and finish in any order. */
  #remove(map: Map<ModuleId, Instance>): void {
    const index = this.#maps.lastIndexOf(map)
    if (index > 0) this.#maps.splice(index, 1)
  }

  /**
   * Runs `load` with a fresh instance map of its own, in its async context: everything it loads,
   * synchronously or after an await, lands there and is dropped with it, and a load started
   * outside it never sees it.
   */
  #inScratch<R>(load: () => R): R {
    this.#scratch ??= new AsyncLocalStorage()
    this.#scratchLoads++
    let result: R
    try {
      result = this.#scratch.run(new Map(), load)
    } catch (error) {
      this.#scratchLoads--
      throw error
    }
    if (result instanceof Promise) {
      return result.finally(() => {
        this.#scratchLoads--
      }) as R
    }
    this.#scratchLoads--
    return result
  }

  // ---- the runner's own loads: never mocked themselves ----

  /** The runner's `import(specifier)` of a setup or test file: link asynchronously, then evaluate. */
  async load(specifier: string, importer: string, isTest: boolean): Promise<object> {
    const target = resolveTarget(this.#state, specifier, importer, 'import')
    if (target.kind !== 'user') return this.#externalAsync(target)
    // An entry the file asked for: no edge of another module leads to it.
    this.#touched?.add(target.id)
    const record = recordFor(this.#state, target.id, isTest)
    await linkAsync(this.#state, record)
    return this.#evaluateForImport(record)
  }

  /** The runner's `require(specifier)`: link and evaluate synchronously. */
  loadSync(specifier: string, importer: string, isTest: boolean): unknown {
    const target = resolveTarget(this.#state, specifier, importer, 'require')
    if (target.kind !== 'user') return this.#requireExternal(target)
    this.#touched?.add(target.id)
    const record = recordFor(this.#state, target.id, isTest)
    linkSync(this.#state, record)
    return this.#requireRecord(record)
  }

  // ---- edges from a module ----

  /** An `import()` from `importer`, through the mock decision. */
  async importFrom(specifier: string, importer: string): Promise<object> {
    const target = resolveOrMissing(this.#state, specifier, importer, 'import')
    const mocked = this.#mockOf(target, specifier, importer, 'esm')
    if (mocked !== REAL) return (await this.#settleFor(mocked, specifier, 'async')) as object
    const found = this.#maybeInline(target as Found)
    if (found.kind !== 'user') return this.#externalAsync(found)
    this.#noteLoad(importer, found.id)
    const record = recordFor(this.#state, found.id, false)
    await linkAsync(this.#state, record)
    return this.#evaluateForImport(record)
  }

  /** A `require` from `importer` (from `record`, whose linked targets it reuses), through the mock decision. */
  requireFrom(specifier: string, importer: string, record?: ModuleRecord): unknown {
    const target =
      record === undefined
        ? resolveOrMissing(this.#state, specifier, importer, 'require')
        : this.#targetOf(record, specifier, 'require')
    const mocked = this.#mockOf(target, specifier, importer, 'cjs')
    if (mocked !== REAL) {
      if (mocked instanceof Pending) {
        throw requireError(`'${specifier}'`, 'its mock is asynchronous')
      }
      return mocked
    }
    const found = this.#maybeInline(target as Found)
    if (found.kind !== 'user') return this.#requireExternal(found)
    // A target the record linked is an edge the closure walk follows already.
    if (record?.resolved.get(specifier) !== target) this.#noteLoad(importer, found.id)
    const dep = recordFor(this.#state, found.id, false)
    linkSync(this.#state, dep)
    return this.#requireRecord(dep)
  }

  /** A static import inside `record`'s wrapper, evaluating in `mode`: its target was linked ahead. */
  #importEdge(record: ModuleRecord, specifier: string, mode: Mode): unknown {
    const target = this.#targetOf(record, specifier, 'import')
    const mocked = this.#mockOf(target, specifier, record.path, 'esm')
    if (mocked !== REAL) return this.#settleFor(mocked, specifier, mode)
    const found = this.#maybeInline(target as Found)
    if (found.kind !== 'user') return this.#externalImport(found)
    // Linked ahead, unless an edge inlined it just now.
    const dep = this.#state.records.get(found.id) ?? this.#linkNow(found.id)
    return this.#importRecord(dep, mode)
  }

  /** A late import (D38) on the sync path: what `require()` of a rewritten ES module needs. */
  #lateImportSync(record: ModuleRecord, specifier: string): unknown {
    const target = resolveOrMissing(this.#state, specifier, record.path, 'import')
    const mocked = this.#mockOf(target, specifier, record.path, 'esm')
    if (mocked !== REAL) return this.#settleFor(mocked, specifier, 'sync')
    const found = this.#maybeInline(target as Found)
    if (found.kind !== 'user') return this.#externalImport(found)
    this.#noteLoad(record.path, found.id)
    const dep = recordFor(this.#state, found.id, false)
    linkSync(this.#state, dep)
    return this.#importRecord(dep, 'sync')
  }

  /** A mocked value for a wrapper in `mode`: an async one awaits a pending mock, a sync one can't. */
  #settleFor(mocked: unknown, specifier: string, mode: Mode): unknown {
    if (!(mocked instanceof Pending)) return mocked
    if (mode === 'async') return mocked.promise
    throw syncLoadError(`'${specifier}'`, 'its mock is asynchronous')
  }

  /**
   * The mock decision for an edge: the mocked value shaped for the edge, or `REAL`. A specifier
   * that didn't resolve is mocked only if `decideUnresolved` says so, and a module that didn't
   * transform only if `decide` does; otherwise its error is thrown here, when the edge runs.
   */
  #mockOf(target: Target, specifier: string, importer: string, style: Style): unknown {
    const mocks = this.context.mocks
    if (target.kind === 'missing' || target.kind === 'served') {
      const served = target.kind === 'served' ? this.#served(specifier, importer, style) : REAL
      if (served !== REAL) return served
      const found = mocks?.decideUnresolved(specifier, importer)
      if (mocks !== null && found?.mocked === true) return this.#mocked(mocks, found.id, style)
      throw new ModuleNotFoundError(target.error.code, target.error.message)
    }
    if (mocks === null) {
      if (target.kind === 'failed') throw target.error
      return REAL
    }
    const id = target.kind === 'user' || target.kind === 'failed' ? target.id : externalKey(target)
    const decision = mocks.decide(
      id,
      importer,
      target.kind === 'builtin' ? 'builtin' : style,
      specifier,
    )
    if (decision.mocked) return this.#mocked(mocks, decision.id, style)
    if (target.kind === 'failed') throw target.error
    return REAL
  }

  /**
   * The value of a module the dialect serves (`ModuleScope.modules`) for `importer`, or `REAL`.
   * Only a `served` target gets here: no name-mapper rule took it over.
   */
  #served(specifier: string, importer: string, style: Style): unknown {
    const scope = this.context.scope
    const values = scope?.(importer as ModuleId)
    if (values === undefined || !Object.hasOwn(values, specifier)) return REAL
    const value = values[specifier]
    const policy = this.#state.options.policy
    return style === 'esm' && policy.factoryShape === 'module-value'
      ? cjsNamespace(value, policy.interopDefault, this.#cache)
      : value
  }

  /**
   * A mocked module's value for an edge. Under `factoryShape: 'module-value'` an `import` sees it
   * through the CommonJS interop, as it would the real `module.exports`; under `awaitFactory` a
   * Promise is a result to wait for, otherwise it is the module itself.
   */
  #mocked(mocks: ModuleMockRegistry, id: string, style: Style): unknown {
    const policy = this.#state.options.policy
    const served = mocks.materialize(id)
    const shape =
      style === 'esm' && policy.factoryShape === 'module-value'
        ? (value: unknown): unknown => cjsNamespace(value, policy.interopDefault, this.#cache)
        : (value: unknown): unknown => value
    if (policy.awaitFactory && isThenable(served)) {
      return new Pending(Promise.resolve(served).then(shape))
    }
    return shape(served)
  }

  // ---- inlining (T2.6) ----

  /**
   * An external as the edge should load it: the same external, or a user module when a mock reaches
   * it. It is inlined when `mocksReachShared` is on and the file's mocks take an edge in its graph
   * closure; the answer is kept for the instance map in play, and later edges follow it.
   */
  #maybeInline(target: Found): Found {
    if (target.kind !== 'external') return target
    const state = this.#state
    const mocks = this.context.mocks
    if (mocks === null || !state.options.policy.mocksReachShared) return target
    const path = target.path
    const map = this.#instances
    let served = this.#memory.get(map)
    if (served === undefined) {
      served = new Map()
      this.#memory.set(map, served)
    }
    let inlined = served.get(path)
    if (inlined === undefined) {
      inlined = false
      if (mocks.active() && !path.endsWith('.node')) {
        const mockedId = mockedReach(state.inline, state.options, path, mocks, (user) =>
          userEdgesOf(state, user),
        )
        if (mockedId !== null) {
          inlined = true
          noteInlined(state.inline, state.options, this.#ledger, toModuleId(path), mockedId)
        }
      }
      served.set(path, inlined)
    }
    return inlined ? { kind: 'user', id: toModuleId(path) } : target
  }

  /** The record of a module an edge inlined, linked now: nothing linked it ahead. */
  #linkNow(id: ModuleId): ModuleRecord {
    const record = recordFor(this.#state, id, false)
    linkSync(this.#state, record)
    return record
  }

  // ---- externals ----

  /** An external's natively required value, shared by the worker (`require`, or the builtin). */
  #requireExternal(target: Found): unknown {
    const key = externalKey(target)
    const state = this.#state
    if (state.required.has(key)) return state.required.get(key)
    const value: unknown = createRequire(
      target.kind === 'external' ? target.path : state.options.root,
    )(key)
    state.required.set(key, value)
    return value
  }

  /** What an `import` of an external sees, synchronously: Node's namespace when preloaded, else the interop over `require`. */
  #externalImport(target: Found): object {
    if (this.#interop === 'node') {
      const native = this.#state.externals.get(externalKey(target))
      if (native !== undefined) return native
    }
    return cjsNamespace(this.#requireExternal(target), this.#interop, this.#cache)
  }

  async #externalAsync(target: Found): Promise<object> {
    await preloadAsync(this.#state, target)
    return this.#externalImport(target)
  }

  // ---- the actual paths ----

  /**
   * The real module behind `id` (a resolved path, a `node:` builtin), synchronously: `require`'s
   * view of it. A scratch load runs in an instance map of its own, dropped afterwards.
   */
  actualSync(id: string, scratch = false): unknown {
    return scratch ? this.#inScratch(() => this.#actualSync(id)) : this.#actualSync(id)
  }

  /** The same through `import`: a CommonJS module as its namespace. */
  actualAsync(id: string, scratch = false): Promise<unknown> {
    return scratch ? this.#inScratch(() => this.#actualAsync(id)) : this.#actualAsync(id)
  }

  #actualTarget(id: string): Found {
    if (id.startsWith('virtual:')) {
      throw new LoaderError('LOADER_NO_REAL_MODULE', `there is no real module behind ${id}`)
    }
    return targetOfId(this.#state, id)
  }

  #actualSync(id: string): unknown {
    const target = this.#maybeInline(this.#actualTarget(id))
    if (target.kind !== 'user') return this.#requireExternal(target)
    this.#touched?.add(target.id)
    const record = recordFor(this.#state, target.id, false)
    linkSync(this.#state, record)
    if (record.format === 'esm' && record.asyncGraph) {
      throw syncLoadError(record.path, 'its graph has top-level await')
    }
    const instance = this.#evaluateSync(record)
    if (record.format === 'cjs') return instance.module?.exports
    if (record.format === 'json') return Reflect.get(instance.exports ?? {}, 'default')
    return this.#viewOf(instance)
  }

  async #actualAsync(id: string): Promise<unknown> {
    const target = this.#maybeInline(this.#actualTarget(id))
    if (target.kind !== 'user') {
      return cjsNamespace(this.#requireExternal(target), this.#interop, this.#cache)
    }
    this.#touched?.add(target.id)
    const record = recordFor(this.#state, target.id, false)
    await linkAsync(this.#state, record)
    // The instance this load evaluates, taken before its await: afterwards `#instances` may name
    // another context's map.
    const evaluated = this.#evaluateForImport(record)
    const instance = this.#instances.get(record.id)
    if (instance === undefined) throw new Error(`${record.id} was evaluated in no instance map`)
    await evaluated
    if (record.format !== 'esm') return this.#importValueOfInstance(instance)
    return this.#viewOf(instance)
  }

  #viewOf(instance: Instance): object {
    instance.view ??= actualView(instance.exports ?? {}, this.#interop)
    return instance.view
  }

  // ---- evaluation ----

  /**
   * Whether `record`, loaded through an async path, evaluates with the async wrapper: its graph
   * awaits, reaches a late import (which may await), or may meet a pending mock.
   */
  #waitsWhenImported(record: ModuleRecord): boolean {
    return record.format === 'esm' && (record.asyncGraph || record.lateGraph || this.#mocksMayWait)
  }

  /** What `import` of `record` resolves to. */
  #evaluateForImport(record: ModuleRecord): object | Promise<object> {
    if (this.#waitsWhenImported(record)) return this.#evaluateAsync(record)
    return this.#importValueOfInstance(this.#evaluateSync(record))
  }

  #requireRecord(record: ModuleRecord): unknown {
    if (record.format === 'esm' && record.asyncGraph) {
      throw requireError(record.path, 'its graph has top-level await')
    }
    const instance = this.#evaluateSync(record)
    if (instance.module !== null) return instance.module.exports
    return record.format === 'json'
      ? Reflect.get(instance.exports ?? {}, 'default')
      : instance.exports
  }

  /**
   * What a static import of `dep` sees from a wrapper in `mode`: a namespace, or inside an async
   * wrapper a Promise of one. A module already evaluating (a cycle) gives its partial namespace.
   */
  #importRecord(dep: ModuleRecord, mode: Mode): unknown {
    const instance = this.#instances.get(dep.id)
    const settled = instance?.status === 'evaluating' || instance?.status === 'done'
    if (!settled && mode === 'async' && this.#waitsWhenImported(dep)) {
      return this.#evaluateAsync(dep)
    }
    if (!settled && dep.format === 'esm' && dep.asyncGraph) {
      throw syncLoadError(dep.path, 'its graph has top-level await')
    }
    return this.#importValueOfInstance(this.#evaluateSync(dep))
  }

  /**
   * The namespace an `import` of an evaluated (or evaluating) instance sees. A CommonJS module's is
   * built from `module.exports` as it stands, and kept once the module has finished.
   */
  #importValueOfInstance(instance: Instance): object {
    if (instance.module === null) return instance.exports ?? {}
    return cjsNamespace(
      instance.module.exports,
      this.#interop,
      instance.status === 'done' ? this.#cache : undefined,
    )
  }

  #newInstance(record: ModuleRecord): Instance {
    const instance: Instance = {
      status: 'evaluating',
      exports:
        record.format === 'cjs'
          ? null
          : record.format === 'json'
            ? moduleNamespace()
            : esmExports(this.#interop),
      module: record.format === 'cjs' ? { exports: {} } : null,
      promise: null,
      error: undefined,
      view: null,
    }
    this.#instances.set(record.id, instance)
    // An instance found rather than made was reached by an edge or an entry that counts itself.
    this.#touched?.add(record.id)
    return instance
  }

  #evaluateSync(record: ModuleRecord): Instance {
    const instances = this.#instances
    const existing = instances.get(record.id)
    if (existing !== undefined) {
      if (existing.status === 'errored') throw existing.error
      return existing
    }
    const instance = this.#newInstance(record)
    try {
      if (record.format === 'json') {
        Object.defineProperty(instance.exports, 'default', {
          enumerable: true,
          value: JSON.parse(record.source),
        })
      } else if (record.format === 'cjs') {
        const module = instance.module
        if (module === null) throw new Error('a CJS instance has no module object')
        this.#wrapper(record, 'sync').call(
          module.exports,
          module.exports,
          this.#requireFor(record),
          module,
          record.path,
          dirname(record.path),
        )
      } else {
        const exports = instance.exports ?? {}
        this.#wrapper(record, 'sync')(
          exports,
          this.#importMeta(record),
          (specifier: string) => this.#importEdge(record, specifier, 'sync'),
          (specifier: string) => this.importFrom(specifier, record.path),
          (source: unknown) => exportAll(exports, source),
          (specifier: string) => this.#lateImportSync(record, specifier),
        )
      }
      instance.status = 'done'
      return instance
    } catch (error) {
      instance.status = 'errored'
      instance.error = error
      // Node and Jest forget a CommonJS module whose evaluation threw, so the next `require` runs
      // it again (after a `doMock`, say). An ES module keeps its error, as Node's does.
      if (record.format === 'cjs' && instances.get(record.id) === instance) {
        instances.delete(record.id)
      }
      throw error
    }
  }

  #evaluateAsync(record: ModuleRecord): Promise<object> {
    const existing = this.#instances.get(record.id)
    if (existing !== undefined) {
      if (existing.status === 'errored') return Promise.reject(existing.error)
      // A cycle back into a module still evaluating sees its partial namespace.
      return existing.promise ?? Promise.resolve(existing.exports ?? {})
    }
    const instance = this.#newInstance(record)
    const exports = instance.exports ?? {}
    const run = async (): Promise<object> => {
      try {
        await this.#wrapper(record, 'async')(
          exports,
          this.#importMeta(record),
          (specifier: string) => this.#importEdge(record, specifier, 'async'),
          (specifier: string) => this.importFrom(specifier, record.path),
          (source: unknown) => exportAll(exports, source),
          (specifier: string) => this.importFrom(specifier, record.path),
        )
        instance.status = 'done'
        return exports
      } catch (error) {
        instance.status = 'errored'
        instance.error = error
        throw error
      }
    }
    instance.promise = run()
    return instance.promise
  }

  /** The record's wrapper for `mode`, with its scope bindings applied. */
  #wrapper(record: ModuleRecord, mode: Mode): Compiled {
    const compiled = compile(this.#state, record, mode)
    const scope = scopeOf(this.#state, record)
    if (scope.length === 0) return compiled
    return compiled(...this.#scopeValues(record, scope)) as Compiled
  }

  /** The values of `record`'s scope bindings: the dialect's from the file, the CommonJS ones from the record. */
  #scopeValues(record: ModuleRecord, scope: readonly string[]): unknown[] {
    const dialect = this.#state.options.moduleScope?.names ?? []
    let values: Readonly<Record<string, unknown>> | undefined
    return scope.map((name) => {
      if (!dialect.includes(name)) {
        if (name === 'require') return this.#requireFor(record)
        if (name === '__filename') return record.path
        if (name === '__dirname') return dirname(record.path)
      }
      values ??= this.context.scope?.(record.id) ?? {}
      return Object.hasOwn(values, name) ? values[name] : Reflect.get(globalThis, name)
    })
  }

  /** `record`'s target for `specifier`, from its link when the kind is the one it was linked with. */
  #targetOf(record: ModuleRecord, specifier: string, kind: ResolveKind): Target {
    const linkedKind: ResolveKind = record.format === 'cjs' ? 'require' : 'import'
    if (kind !== linkedKind) return resolveOrMissing(this.#state, specifier, record.path, kind)
    const target = record.resolved.get(specifier)
    if (target !== undefined) return target
    const resolved = resolveOrMissing(this.#state, specifier, record.path, kind)
    setResolved(this.#state, record, specifier, resolved)
    return resolved
  }

  #requireFor(record: ModuleRecord): NodeJS.Require {
    const native = createRequire(record.path)
    const require = ((specifier: string) =>
      this.requireFrom(specifier, record.path, record)) as NodeJS.Require
    const resolve = ((specifier: string) => {
      const target = resolveTarget(this.#state, specifier, record.path, 'require')
      return target.kind === 'external' ? target.path : target.id
    }) as NodeJS.RequireResolve
    resolve.paths = native.resolve.paths
    require.resolve = resolve
    require.cache = native.cache
    require.extensions = native.extensions
    require.main = undefined
    return require
  }

  #importMeta(record: ModuleRecord): object {
    return {
      url: pathToFileURL(record.path).href,
      filename: record.path,
      dirname: dirname(record.path),
      main: false,
      resolve: (specifier: string) => {
        const target = resolveTarget(this.#state, specifier, record.path, 'import-meta-resolve')
        return target.kind === 'builtin'
          ? target.id
          : pathToFileURL(target.kind === 'user' ? target.id : target.path).href
      },
    }
  }
}
