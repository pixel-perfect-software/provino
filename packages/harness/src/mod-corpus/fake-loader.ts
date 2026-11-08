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
  /** Where `__mocks__` directories are looked for (Jest's `roots`); the work directory if absent. */
  readonly roots?: readonly string[]
  readonly hoist: HoistPolicy
  readonly policy: ModulePolicy
  readonly mockPolicy: MockPolicy
  readonly mocks: MockRegistry
  readonly facades: (from: string, ops: LoaderOps) => Facades
  /**
   * The non-vacuity checks' broken engines. `inert`: no import edge asks the registry, so nothing
   * is mocked (root `__mocks__` files included). `wrong-values`: the registry decides and runs its
   * factories as usual, but every mocked edge is served an empty module.
   */
  readonly sabotage?: 'inert' | 'wrong-values'
  /**
   * Whether an error-severity hoist diagnostic is raised as `<file>: <message>`, as Babel's
   * transform errors are (Jest). B13c's loader must do the same for that dialect.
   */
  readonly prefixTransformErrors?: boolean
}

interface Compiled {
  readonly path: string
  readonly format: 'esm' | 'cjs'
  readonly fn: (...args: unknown[]) => unknown
  readonly async: boolean
}

interface Box {
  exports: unknown
  /** The view of an ES module's exports that `loadActual` hands out: getters over the live exports. */
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
 * A CommonJS value seen through `import`, as `ModulePolicy.interopDefault` says. `babel`: a value
 * that carries `__esModule` is its own namespace, otherwise Babel's `_interopRequireWildcard` gives
 * `default` first and then the value's own keys. `node`: Node's ES namespace over a CommonJS
 * module, a `Module` with every key, `default` included, sorted by name, whatever the value carries.
 */
function interop(value: unknown, babel: boolean): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { default: value }
  }
  if (babel && (value as { __esModule?: unknown }).__esModule === true) return value
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
  /** `ModulePolicy.interopDefault`: Babel's module shapes, or Node's. */
  readonly #babel: boolean
  readonly #resolver: Resolver
  readonly #pipeline: Pipeline
  readonly #compiled = new Map<string, Compiled>()
  #layers: Map<string, Box>[] = [new Map()]

  constructor(options: FakeLoaderOptions) {
    this.#options = options
    this.#babel = options.policy.interopDefault === 'babel'
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
      roots: options.roots ?? [options.root],
      extensions: ['.ts'],
      loadActual: (id) => this.#loadActualId(id),
    })
  }

  /** Evaluates the test file; resolves when its body (and its hoisted imports) has run. */
  async loadTestFile(file: string): Promise<void> {
    try {
      await this.#settle(this.#evaluate(this.#compile(file, 'test')))
    } catch (error) {
      // Where a relative mock cannot stand in for a path that is not on disk (`virtualRelative:
      // false`), the module runner names the importer when the file fails to load on it, which
      // an import from inside a test does not: `Cannot find module '/x.ts' imported from <file>`.
      if (
        error instanceof Error &&
        (error as { code?: unknown }).code === 'unresolved-relative-mock'
      ) {
        throw new Error(`${error.message} imported from ${file}`, { cause: error })
      }
      throw error
    }
  }

  ops(): LoaderOps {
    const actual = (specifier: string, from: string): unknown =>
      this.#loadActualId(this.#fileOf(specifier, from, 'mock'))
    return {
      registry: this.registry,
      actual,
      mockOf: (specifier, from) => this.registry.materialize(this.#idOf(specifier, from)),
      actualForAutomock: actual,
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
    throw this.#notFound(specifier, from)
  }

  #notFound(specifier: string, from: string): Error {
    return new Error(
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
    throw this.#notFound(specifier, from)
  }

  // ---- edges ----

  /** One import edge: resolve, ask the registry, then the mock or the real module. */
  #edge(specifier: string, importer: string, style: Style): unknown {
    const result = this.#resolve(specifier, importer, style === 'cjs' ? 'require' : 'import')
    if (result.type === 'not-found') {
      const found =
        this.#options.sabotage === 'inert'
          ? undefined
          : this.registry.decideUnresolved(specifier, importer)
      if (found?.mocked === true) return this.#mocked(found.id, style)
      throw this.#notFound(specifier, importer)
    }
    if (result.type === 'virtual') throw new Error(`unexpected virtual module ${result.id}`)
    const id = result.type === 'file' ? result.path : result.id
    const kind = result.type === 'builtin' ? 'builtin' : style
    if (this.#options.sabotage === 'inert') return this.#actual(id, style)
    const decision = this.registry.decide(id, importer, kind, specifier)
    if (decision.mocked) return this.#mocked(decision.id, style)
    return this.#actual(id, style)
  }

  #mocked(id: string, style: Style): unknown {
    const served = this.registry.materialize(id)
    const value = this.#options.sabotage === 'wrong-values' ? {} : served
    const shape = (v: unknown): unknown =>
      style === 'esm' && this.#options.policy.factoryShape === 'module-value'
        ? interop(v, this.#babel)
        : v
    // Under `awaitFactory` a Promise is a result to wait for; otherwise it is the module itself.
    return this.#options.policy.awaitFactory && isThenable(value)
      ? new Pending(Promise.resolve(value).then(shape))
      : shape(value)
  }

  #actual(id: string, style: Style, view = false): unknown {
    if (id.startsWith('node:')) {
      const value = process.getBuiltinModule(id as `node:${string}`)
      return style === 'esm' ? interop(value, this.#babel) : value
    }
    if (isExternal(id)) {
      const value: unknown = createRequire(id)(id)
      return style === 'esm' ? interop(value, this.#babel) : value
    }
    const compiled = this.#compile(id, 'source')
    const loaded = this.#evaluate(compiled)
    const shape = (box: Box): unknown => {
      if (view) return this.#view(compiled, box)
      return style === 'esm' && compiled.format === 'cjs'
        ? interop(box.exports, this.#babel)
        : box.exports
    }
    return loaded instanceof Pending
      ? new Pending(loaded.promise.then((box) => shape(box as Box)))
      : shape(loaded)
  }

  /** `loadActual` for the registry and the facades: how the policy says the real module loads. */
  #loadActualId(id: string): unknown {
    const style: Style = this.#options.policy.actual === 'async-import' ? 'esm' : 'cjs'
    if (id.startsWith('virtual:')) throw new Error(`there is no real module behind ${id}`)
    const value = this.#actual(id, style, true)
    if (style === 'cjs') {
      if (value instanceof Pending)
        throw new Error(`${id} cannot be required: it has top-level await`)
      return value
    }
    return value instanceof Pending ? value.promise : Promise.resolve(value)
  }

  /**
   * What `loadActual` hands out for a source ES module: its exports as getters over the live
   * module, as the runners serve them (so automock's getter rule and its `Module` rule run). Under
   * `interopDefault: 'babel'` it is Babel's exports object, a non-enumerable `__esModule` and the
   * names sorted; under `node` it is a namespace (`Symbol.toStringTag` `Module`) in source order.
   */
  #view(compiled: Compiled, box: Box): unknown {
    if (compiled.format !== 'esm') return box.exports
    if (box.view !== undefined) return box.view
    const source = box.exports as Record<string, unknown>
    const view: Record<string | symbol, unknown> = Object.create(null)
    if (this.#babel) Object.defineProperty(view, '__esModule', { value: true })
    else Object.defineProperty(view, Symbol.toStringTag, { value: 'Module' })
    const keys = Object.keys(source)
    for (const key of this.#babel ? keys.sort() : keys) {
      Object.defineProperty(view, key, { enumerable: true, get: () => source[key] })
    }
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
      if (d.severity === 'error') {
        throw new Error(
          this.#options.prefixTransformErrors === true ? `${file}: ${d.message}` : d.message,
        )
      }
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

  /** The instance box for a compiled module, evaluating it once per layer; a Promise when async. */
  #evaluate(compiled: Compiled): Box | Pending {
    const layer = this.#layers[this.#layers.length - 1]
    if (layer === undefined) throw new Error('no module layer')
    const known = layer.get(compiled.path)
    if (known !== undefined) return known
    const file = compiled.path
    const facades = this.#options.facades(file, this.ops())
    if (compiled.format === 'esm') {
      // Babel's exports object is a plain one with `__esModule`; the module runner's (Node's
      // shape) is a null-prototype `Module` namespace, as `moduleNamespace()` in the loader makes.
      const exports: Record<string | symbol, unknown> = this.#babel ? {} : Object.create(null)
      const box: Box = { exports }
      if (this.#babel) Object.defineProperty(exports, '__esModule', { value: true })
      else Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
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
