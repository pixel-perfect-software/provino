// Test-only: one file's module system for the mod corpus (B13b, T4.7). It stands in for the real
// loader until B13c wires `@provino/mock`'s module registry into it. Everything it hands the
// registry is real: the resolver, the pipeline with the profile's hoist policy and `toModuleRunner`.
// Every import edge (static, dynamic, require) resolves, then asks `registry.decide(...)` (or
// `decideUnresolved` on a miss); a mocked edge takes `registry.materialize(id)`, anything else loads
// the real module into a per-file instance cache. Each module gets its own `jest` and `vi`, passed as
// wrapper parameters, so a call's `from` is the calling file (the shape B13c needs, Gap 1).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import type { MockRegistry } from '@provino/mock'
import { createModuleMockRegistry, type ModuleMockRegistry } from '@provino/mock'
import { createResolver } from '@provino/resolver'
import { createPipeline, toModuleRunner } from '@provino/transform'
import type {
  HoistPolicy,
  MockPolicy,
  ModulePolicy,
  Pipeline,
  ResolveKind,
  Resolver,
} from '@provino/types'

// The loader's own wrapper parameters (`packages/loader/src/internal/records.ts`), then what a
// corpus file needs on top: Jest's `require` inside an ESM-form file (`injectCjsGlobals`), and the
// two facades.
const ESM_PARAMS =
  '__vite_ssr_exports__, __vite_ssr_import_meta__, __vite_ssr_import__, __vite_ssr_dynamic_import__, __vite_ssr_exportAll__'
const CJS_PARAMS = 'exports, require, module, __filename, __dirname'
const FACADES = 'jest, vi'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']

/** The test-object pair a module sees: the profile's is real, the other `undefined`. */
export interface Facades {
  readonly jest: unknown
  readonly vi: unknown
}

/** What a facade builder gets: the module-system calls it wraps, each bound to nothing. */
export interface LoaderOps {
  readonly registry: ModuleMockRegistry
  /** The real module for `specifier` as `from` would resolve it, loaded as the policy says. */
  actual(specifier: string, from: string): unknown
  /** `registry.materialize` for the id `specifier` resolves to, whether or not it is registered. */
  mockOf(specifier: string, from: string): unknown
  /** The real module's exports for `createMockFromModule`. */
  actualForAutomock(specifier: string, from: string): unknown
  resetModules(): void
  isolate(fn: () => unknown): void
}

export interface FakeLoaderOptions {
  /** The work directory (real path), where the fixture was copied. */
  readonly root: string
  readonly hoist: HoistPolicy
  readonly policy: ModulePolicy
  readonly mockPolicy: MockPolicy
  readonly mocks: MockRegistry
  readonly facades: (from: string, ops: LoaderOps) => Facades
  /**
   * Whether a source ES module's exports look like Babel's output (Jest's transform): a
   * non-enumerable `__esModule`, and `default` first when the exports are copied.
   */
  readonly babelExports: boolean
}

interface Compiled {
  readonly path: string
  readonly format: 'esm' | 'cjs'
  readonly fn: (...args: unknown[]) => unknown
  readonly async: boolean
  readonly deps: readonly string[]
}

interface Box {
  exports: unknown
  /** The data-property copy of an ES module's exports that `loadActual` hands out (a namespace). */
  view?: unknown
}

type Style = 'esm' | 'cjs'

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function'

const babelNamespaces = new WeakMap<object, unknown>()
const nodeNamespaces = new WeakMap<object, unknown>()

/**
 * A CommonJS value seen through `import`. A value that carries `__esModule` is its own namespace.
 * Otherwise Babel's `_interopRequireWildcard` (`babel`) gives `default` first and then the value's
 * own keys; Node's ES namespace over a CommonJS module (`node`) is a `Module` with every key,
 * `default` included, sorted by name.
 */
function interop(value: unknown, babel: boolean): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { default: value }
  }
  if ((value as { __esModule?: unknown }).__esModule === true) return value
  const cache = babel ? babelNamespaces : nodeNamespaces
  const known = cache.get(value)
  if (known !== undefined) return known
  const ns = Object.create(null) as Record<string, unknown>
  const keys = Object.keys(value).filter((key) => key !== 'default')
  const copy = (key: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined) Object.defineProperty(ns, key, descriptor)
  }
  if (babel) {
    ns.default = value
    for (const key of keys) copy(key)
  } else {
    for (const key of [...keys, 'default'].sort()) {
      if (key === 'default') ns.default = value
      else copy(key)
    }
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' })
  }
  cache.set(value, ns)
  return ns
}

/** A result that is not ready yet: kept apart from a module whose own value is a Promise. */
class Pending {
  readonly promise: Promise<unknown>
  constructor(promise: Promise<unknown>) {
    this.promise = promise
  }
}

const isExternal = (file: string): boolean => /[\\/]node_modules[\\/]/.test(file)

export class FakeLoader {
  readonly registry: ModuleMockRegistry
  readonly #options: FakeLoaderOptions
  readonly #resolver: Resolver
  readonly #pipeline: Pipeline
  readonly #compiled = new Map<string, Compiled>()
  #layers: Map<string, Box>[] = [new Map()]

  constructor(options: FakeLoaderOptions) {
    this.#options = options
    this.#resolver = createResolver({
      root: options.root,
      mappers: [],
      extensions: EXTENSIONS,
      tsconfig: false,
    })
    this.#pipeline = createPipeline({
      root: options.root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: options.hoist,
      cache: false,
    })
    this.registry = createModuleMockRegistry({
      policy: options.policy,
      mockPolicy: options.mockPolicy,
      mocks: options.mocks,
      resolver: this.#resolver,
      roots: [options.root],
      extensions: ['.ts'],
      loadActual: (id, importer) => this.#loadActualId(id, importer),
    })
  }

  /** Evaluates the test file; resolves when its body (and its hoisted imports) has run. */
  async loadTestFile(file: string): Promise<void> {
    await this.#settle(this.#load(file, 'test', 'esm'))
  }

  ops(): LoaderOps {
    return {
      registry: this.registry,
      actual: (specifier, from) => this.#loadActualId(this.#fileOf(specifier, from, 'mock'), from),
      mockOf: (specifier, from) => this.registry.materialize(this.#idOf(specifier, from)),
      actualForAutomock: (specifier, from) =>
        this.#loadActualId(this.#fileOf(specifier, from, 'mock'), from),
      resetModules: () => {
        for (const layer of this.#layers) layer.clear()
        this.registry.onResetModules()
      },
      isolate: (fn) => {
        this.registry.enterIsolation('isolateModules', 'isolateModulesAsync')
        this.#layers.push(new Map())
        try {
          fn()
        } finally {
          this.#layers.pop()
          this.registry.exitIsolation()
        }
      },
    }
  }

  // ---- resolving ----

  #resolve(specifier: string, importer: string, kind: ResolveKind) {
    return this.#resolver.resolve(specifier, { importer, kind, conditions: [] })
  }

  #fileOf(specifier: string, from: string, kind: ResolveKind): string {
    const result = this.#resolve(specifier, from, kind)
    if (result.type === 'file') return result.path
    if (result.type === 'builtin') return result.id
    throw new Error(
      `Cannot find module '${specifier}' from '${path.relative(this.#options.root, from)}'`,
    )
  }

  /** The id the registry knows `specifier` by (what `register` made of it). */
  #idOf(specifier: string, from: string): string {
    const result = this.#resolve(specifier, from, 'mock')
    if (result.type === 'file') return result.path
    if (result.type === 'builtin') return result.id
    const found = this.registry.decideUnresolved(specifier, from)
    if (found.mocked) return found.id
    throw new Error(
      `Cannot find module '${specifier}' from '${path.relative(this.#options.root, from)}'`,
    )
  }

  // ---- edges ----

  /** One import edge: resolve, ask the registry, then the mock or the real module. */
  #edge(specifier: string, importer: string, style: Style): unknown {
    const result = this.#resolve(specifier, importer, style === 'cjs' ? 'require' : 'import')
    if (result.type === 'not-found') {
      const found = this.registry.decideUnresolved(specifier, importer)
      if (found.mocked) return this.#mocked(found.id, style)
      throw new Error(
        `Cannot find module '${specifier}' from '${path.relative(this.#options.root, importer)}'`,
      )
    }
    if (result.type === 'virtual') throw new Error(`unexpected virtual module ${result.id}`)
    const id = result.type === 'file' ? result.path : result.id
    const kind = result.type === 'builtin' ? 'builtin' : style
    const decision = this.registry.decide(id, importer, kind, specifier)
    if (decision.mocked) return this.#mocked(decision.id, style)
    return this.#actual(id, importer, style)
  }

  #mocked(id: string, style: Style): unknown {
    const value = this.registry.materialize(id)
    const shape = (v: unknown): unknown =>
      style === 'esm' && this.#options.policy.factoryShape === 'module-value'
        ? interop(v, this.#options.babelExports)
        : v
    // Under `awaitFactory` a Promise is a result to wait for; otherwise it is the module itself.
    return this.#options.policy.awaitFactory && isThenable(value)
      ? new Pending(Promise.resolve(value).then(shape))
      : shape(value)
  }

  #actual(id: string, importer: string, style: Style, view = false): unknown {
    if (id.startsWith('node:')) {
      const value = process.getBuiltinModule(id as `node:${string}`)
      return style === 'esm' ? interop(value, this.#options.babelExports) : value
    }
    if (isExternal(id)) {
      const value: unknown = createRequire(id)(id)
      return style === 'esm' ? interop(value, this.#options.babelExports) : value
    }
    const compiled = this.#compile(id, 'source')
    const loaded = this.#evaluate(compiled, importer)
    const shape = (box: Box): unknown => {
      if (view) return this.#view(compiled, box)
      return style === 'esm' && compiled.format === 'cjs'
        ? interop(box.exports, this.#options.babelExports)
        : box.exports
    }
    return loaded instanceof Pending
      ? new Pending(loaded.promise.then((box) => shape(box as Box)))
      : shape(loaded)
  }

  /** `loadActual` for the registry and the facades: how the policy says the real module loads. */
  #loadActualId(id: string, importer: string): unknown {
    const style: Style = this.#options.policy.actual === 'async-import' ? 'esm' : 'cjs'
    if (id.startsWith('virtual:')) throw new Error(`there is no real module behind ${id}`)
    const value = this.#actual(id, importer, style, true)
    if (style === 'cjs') {
      if (value instanceof Pending)
        throw new Error(`${id} cannot be required: it has top-level await`)
      return value
    }
    return value instanceof Pending ? value.promise : Promise.resolve(value)
  }

  /**
   * What `loadActual` hands out for a source ES module: a namespace of data properties, as a real
   * module namespace reports them (the runner's exports are getters). Under Babel's shape `default`
   * comes first and `__esModule` is kept.
   */
  #view(compiled: Compiled, box: Box): unknown {
    if (compiled.format !== 'esm') return box.exports
    if (box.view !== undefined) return box.view
    const source = box.exports as Record<string, unknown>
    const view: Record<string, unknown> = {}
    if (this.#options.babelExports) {
      Object.defineProperty(view, '__esModule', { value: true })
    }
    // Babel lists the exports sorted by name (`default` among them), where a namespace keeps source order.
    const keys = Object.keys(source)
    for (const key of this.#options.babelExports ? keys.sort() : keys) view[key] = source[key]
    box.view = view
    return view
  }

  // ---- compiling and evaluating ----

  #compile(file: string, role: 'test' | 'source'): Compiled {
    const known = this.#compiled.get(file)
    if (known !== undefined) return known
    const source = readFileSync(file, 'utf8')
    const record = this.#pipeline.transform({
      filename: file,
      source,
      role,
      consumer: 'import',
      instrument: false,
    })
    for (const d of record.diagnostics) {
      if (d.severity === 'error') throw new Error(d.message)
    }
    // A file with only `import()` calls has no module syntax (`unknown`) but still needs the runner form.
    const esm =
      record.format === 'esm' ||
      (record.format === 'unknown' && record.imports.some((entry) => entry.kind === 'dynamic'))
    const runner = esm ? toModuleRunner(file, record) : null
    let body = runner === null ? record.code : runner.code
    const deps = runner === null ? [] : runner.deps
    const async = esm && (record.hasTopLevelAwait || this.#depsAsync(file, deps, new Set([file])))
    if (esm && !async) body = body.replaceAll('await __vite_ssr_import__(', '__vite_ssr_import__(')
    const prefix = esm
      ? `'use strict';(${async ? 'async ' : ''}function (${ESM_PARAMS}, require, ${FACADES}) {`
      : `(function (${CJS_PARAMS}, ${FACADES}) {`
    const fn: unknown = runInThisContext(`${prefix}${body}\n})`, { filename: file })
    if (typeof fn !== 'function') throw new Error(`the wrapper for ${file} is not a function`)
    const compiled: Compiled = {
      path: file,
      format: esm ? 'esm' : 'cjs',
      fn: fn as Compiled['fn'],
      async,
      deps,
    }
    this.#compiled.set(file, compiled)
    return compiled
  }

  /** Whether a static dependency of `file` is itself an async module (the loader's `asyncGraph`). */
  #depsAsync(file: string, deps: readonly string[], seen: Set<string>): boolean {
    for (const dep of deps) {
      const result = this.#resolve(dep, file, 'import')
      if (result.type !== 'file' || isExternal(result.path) || seen.has(result.path)) continue
      seen.add(result.path)
      if (this.#compile(result.path, 'source').async) return true
    }
    return false
  }

  #load(file: string, role: 'test' | 'source', _style: Style): unknown {
    return this.#evaluate(this.#compile(file, role), file)
  }

  /** The instance box for a compiled module, evaluating it once per layer; a Promise when async. */
  #evaluate(compiled: Compiled, importer: string): Box | Pending {
    const layer = this.#layers[this.#layers.length - 1]
    if (layer === undefined) throw new Error('no module layer')
    const known = layer.get(compiled.path)
    if (known !== undefined) return known
    const file = compiled.path
    const facades = this.#options.facades(file, this.ops())
    if (compiled.format === 'esm') {
      const exports: Record<string, unknown> = {}
      const box: Box = { exports }
      if (this.#options.babelExports) {
        Object.defineProperty(exports, '__esModule', { value: true })
      }
      layer.set(file, box)
      const meta = { url: pathToFileURL(file).href, filename: file, dirname: path.dirname(file) }
      const exportAll = (ns: Record<string, unknown>): void => {
        for (const key of Object.keys(ns)) {
          if (key === 'default' || key in exports) continue
          Object.defineProperty(exports, key, { enumerable: true, get: () => ns[key] })
        }
      }
      const result = compiled.fn(
        exports,
        meta,
        (spec: string) => this.#settle(this.#edge(spec, file, 'esm')),
        (spec: string) => new Promise((done) => done(this.#settle(this.#edge(spec, file, 'esm')))),
        exportAll,
        (spec: string) => this.#requireFrom(spec, file),
        facades.jest,
        facades.vi,
      )
      return compiled.async ? new Pending(Promise.resolve(result).then(() => box)) : box
    }
    const module: Box = { exports: {} }
    layer.set(file, module)
    compiled.fn(
      module.exports,
      (spec: string) => this.#requireFrom(spec, file),
      module,
      file,
      path.dirname(file),
      facades.jest,
      facades.vi,
    )
    void importer
    return module
  }

  /** What an ESM wrapper receives: a Pending result as its Promise. */
  #settle(value: unknown): unknown {
    return value instanceof Pending ? value.promise : value
  }

  #requireFrom(specifier: string, from: string): unknown {
    const value = this.#edge(specifier, from, 'cjs')
    if (value instanceof Pending)
      throw new Error(`Cannot require '${specifier}': it is asynchronous`)
    return value
  }
}
