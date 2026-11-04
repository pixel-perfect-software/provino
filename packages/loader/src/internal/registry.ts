// The per-file half of the engine (Track 2 R1 steps 3–4, F3): instances of the worker's records,
// evaluated synchronously unless their subgraph has top-level await. A registry never compiles or
// transforms; it calls the records' compiled wrappers with fresh linkers.
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleId, ModulePolicy } from '@provino/types'
import { LoaderError } from '../errors.ts'
import {
  compile,
  linkAsync,
  linkSync,
  type ModuleRecord,
  type Records,
  recordFor,
  resolveTarget,
  setResolved,
  type Target,
} from './records.ts'

interface Instance {
  status: 'evaluating' | 'done' | 'errored'
  /** The ESM namespace, or the import view of a CJS or JSON module. */
  namespace: object
  /** CJS: the `module` object; `require()` returns its `exports`. */
  readonly module: { exports: unknown } | null
  promise: Promise<object> | null
  error: unknown
}

function moduleNamespace(): Record<string | symbol, unknown> {
  const namespace: Record<string | symbol, unknown> = Object.create(null)
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })
  return namespace
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

/** The ESM view of a CJS module's exports, live, with the dialect's default interop. */
function cjsView(module: { exports: unknown }, interop: ModulePolicy['interopDefault']): object {
  const namespace = moduleNamespace()
  const exports = module.exports
  if (exports !== null && (typeof exports === 'object' || typeof exports === 'function')) {
    for (const key of Object.keys(exports)) {
      if (key === 'default') continue
      Object.defineProperty(namespace, key, {
        enumerable: true,
        get: () => Reflect.get(module.exports as object, key),
      })
    }
  }
  const esModule =
    interop === 'babel' &&
    exports !== null &&
    typeof exports === 'object' &&
    Reflect.get(exports, '__esModule') === true
  Object.defineProperty(namespace, 'default', {
    enumerable: true,
    get: () => (esModule ? Reflect.get(module.exports as object, 'default') : module.exports),
  })
  return namespace
}

/**
 * One stack of instance maps: the top is used; `isolateModules` pushes a fresh one and removes
 * that same map when it finishes, wherever it ended up in the stack.
 */
export class Registry {
  readonly #state: Records
  readonly #maps: Map<ModuleId, Instance>[]

  constructor(state: Records, base: Map<ModuleId, Instance> = new Map()) {
    this.#state = state
    this.#maps = [base]
  }

  get #instances(): Map<ModuleId, Instance> {
    const top = this.#maps.at(-1)
    if (top === undefined) throw new Error('registry has no instance map')
    return top
  }

  loaded(): ModuleId[] {
    return [...new Set(this.#maps.flatMap((map) => [...map.keys()]))]
  }

  /**
   * Empties every layer of the stack and keeps its depth, so an `isolateModules` call that is
   * still running removes its own (now empty) map when it finishes.
   */
  reset(): void {
    for (const map of this.#maps) map.clear()
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
      let target: Target
      try {
        target = resolveTarget(this.#state, specifier, importer, kind)
      } catch (error) {
        if (error instanceof LoaderError && error.code === 'ERR_MODULE_NOT_FOUND') continue
        throw error
      }
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

  /** `import(specifier)` from `importer`: link asynchronously, then evaluate. */
  async import(specifier: string, importer: string, isEntry: boolean): Promise<object> {
    const target = resolveTarget(this.#state, specifier, importer, 'import')
    if (target.kind !== 'user') return this.#externalAsync(target)
    const record = recordFor(this.#state, target.id, isEntry)
    await linkAsync(this.#state, record)
    return record.asyncGraph ? this.#evaluateAsync(record) : this.#namespaceOf(record)
  }

  /** `require(specifier)` from `importer`: link and evaluate synchronously. */
  require(specifier: string, importer: string, isEntry: boolean): unknown {
    const target = resolveTarget(this.#state, specifier, importer, 'require')
    if (target.kind !== 'user') return this.#nativeRequire(target, importer)
    const record = recordFor(this.#state, target.id, isEntry)
    linkSync(this.#state, record)
    return this.#requireRecord(record)
  }

  #nativeRequire(target: Target, from: string): unknown {
    if (target.kind === 'user') throw new Error('not an external')
    return createRequire(from)(target.kind === 'builtin' ? target.id : target.path)
  }

  async #externalAsync(target: Target): Promise<object> {
    if (target.kind === 'user') throw new Error('not an external')
    const key = target.kind === 'builtin' ? target.id : target.path
    const cached = this.#state.externals.get(key)
    if (cached !== undefined) return cached
    const namespace: object = await import(
      target.kind === 'builtin' ? target.id : pathToFileURL(target.path).href
    )
    this.#state.externals.set(key, namespace)
    return namespace
  }

  #requireRecord(record: ModuleRecord): unknown {
    if (record.format === 'esm' && record.asyncGraph) {
      throw new LoaderError(
        'ERR_REQUIRE_ASYNC_MODULE',
        `require() cannot load ${record.path}: its graph has top-level await`,
      )
    }
    const instance = this.#evaluateSync(record)
    if (instance.module !== null) return instance.module.exports
    return record.format === 'json'
      ? Reflect.get(instance.namespace, 'default')
      : instance.namespace
  }

  /** The value an ESM import of `target` sees: a namespace. */
  #importValue(target: Target): object {
    if (target.kind === 'user') {
      const record = this.#state.records.get(target.id)
      if (record === undefined) throw new Error(`${target.id} was never linked`)
      const instance = this.#instances.get(record.id)
      if (record.asyncGraph && instance?.status !== 'evaluating' && instance?.status !== 'done') {
        // Only reached from inside an async wrapper, which awaits the promise.
        return this.#evaluateAsync(record)
      }
      return this.#namespaceOf(record)
    }
    const key = target.kind === 'builtin' ? target.id : target.path
    const namespace = this.#state.externals.get(key)
    if (namespace === undefined) throw new Error(`${key} was never preloaded`)
    return namespace
  }

  #namespaceOf(record: ModuleRecord): object {
    return this.#evaluateSync(record).namespace
  }

  #newInstance(record: ModuleRecord): Instance {
    const module = record.format === 'cjs' ? { exports: {} } : null
    const instance: Instance = {
      status: 'evaluating',
      namespace:
        module === null
          ? moduleNamespace()
          : cjsView(module, this.#state.options.policy.interopDefault),
      module,
      promise: null,
      error: undefined,
    }
    this.#instances.set(record.id, instance)
    return instance
  }

  #evaluateSync(record: ModuleRecord): Instance {
    const existing = this.#instances.get(record.id)
    if (existing !== undefined) {
      if (existing.status === 'errored') throw existing.error
      return existing
    }
    const instance = this.#newInstance(record)
    try {
      if (record.format === 'json') {
        Object.defineProperty(instance.namespace, 'default', {
          enumerable: true,
          value: JSON.parse(record.source),
        })
      } else if (record.format === 'cjs') {
        const module = instance.module
        if (module === null) throw new Error('a CJS instance has no module object')
        compile(this.#state, record).call(
          module.exports,
          module.exports,
          this.#requireFor(record),
          module,
          record.path,
          dirname(record.path),
        )
        // `module.exports` may have been replaced: rebuild the live view.
        instance.namespace = cjsView(module, this.#state.options.policy.interopDefault)
      } else {
        compile(this.#state, record)(
          instance.namespace,
          this.#importMeta(record),
          (specifier: string) => this.#importValue(this.#targetOf(record, specifier)),
          (specifier: string) => this.import(specifier, record.path, false),
          (source: unknown) => exportAll(instance.namespace, source),
        )
      }
      instance.status = 'done'
      return instance
    } catch (error) {
      instance.status = 'errored'
      instance.error = error
      throw error
    }
  }

  #evaluateAsync(record: ModuleRecord): Promise<object> {
    const existing = this.#instances.get(record.id)
    if (existing !== undefined) {
      if (existing.status === 'errored') return Promise.reject(existing.error)
      // A cycle back into a module still evaluating sees its partial namespace.
      return existing.promise ?? Promise.resolve(existing.namespace)
    }
    const instance = this.#newInstance(record)
    const run = async (): Promise<object> => {
      try {
        await compile(this.#state, record)(
          instance.namespace,
          this.#importMeta(record),
          (specifier: string) => this.#importValue(this.#targetOf(record, specifier)),
          (specifier: string) => this.import(specifier, record.path, false),
          (source: unknown) => exportAll(instance.namespace, source),
        )
        instance.status = 'done'
        return instance.namespace
      } catch (error) {
        instance.status = 'errored'
        instance.error = error
        throw error
      }
    }
    instance.promise = run()
    return instance.promise
  }

  #targetOf(record: ModuleRecord, specifier: string): Target {
    const target = record.resolved.get(specifier)
    if (target !== undefined) return target
    const kind = record.format === 'cjs' ? 'require' : 'import'
    const resolved = resolveTarget(this.#state, specifier, record.path, kind)
    setResolved(this.#state, record, specifier, resolved)
    return resolved
  }

  #requireFor(record: ModuleRecord): NodeJS.Require {
    const native = createRequire(record.path)
    const require = ((specifier: string) =>
      this.require(specifier, record.path, false)) as NodeJS.Require
    const resolve = ((specifier: string) => {
      const target = resolveTarget(this.#state, specifier, record.path, 'require')
      return target.kind === 'external'
        ? target.path
        : target.kind === 'user'
          ? target.id
          : target.id
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
