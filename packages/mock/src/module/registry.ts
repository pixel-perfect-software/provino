// The module-mock registry (T4.7): one per test file. The loader asks `decide` once per import edge
// and `materialize` for a mocked id; `@provino/mock` owns everything between (registrations,
// `__mocks__` discovery, the factory's result per policy, automock, the isolation overlay).
//
// Brief B13b Gaps 4-6 shape it: the resolver is injected (D34), so `register` resolves at once and
// there is no queue and no `flush`; a virtual module's id stays inside the registry as
// `virtual:<specifier>`; the factory's result shape and missing-export behaviour are policy keys.
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { MockPolicy, MockSpec, ModulePolicy, ResolveResult, Resolver } from '@provino/types'
import { MockError, MockTypeError } from '../errors.ts'
import { createMockFn } from '../mock-fn.ts'
import type { MockRegistry } from '../registry.ts'
import { automock } from './automock.ts'
import {
  coreName,
  findManualMock,
  findRootMock,
  isCoreSpecifier,
  type ManualMock,
} from './manual-mocks.ts'
import { type ModuleMessageCode, moduleMessage } from './messages.ts'

/**
 * Options for one `register` call.
 * @public
 */
export interface RegisterOptions {
  /** The file that made the call (absolute): the specifier resolves from here. */
  readonly from: string
  /** The module need not exist. Under `requireVirtualFlag: false` a missing module is virtual anyway. */
  readonly virtual?: boolean
  /** Where the hoister moved the call from, for error frames. */
  readonly hoisted?: { readonly line: number; readonly column: number }
}

/**
 * The answer to "is this import mocked?". `id` is what `materialize` takes.
 * @public
 */
export type MockDecision =
  | { readonly mocked: false }
  | { readonly mocked: true; readonly id: string }

/**
 * What `createModuleMockRegistry` needs.
 * @public
 */
export interface ModuleMockRegistryOptions {
  readonly policy: ModulePolicy
  readonly mockPolicy: MockPolicy
  /** The file's mock-function registry: every mock the registry makes joins it. */
  readonly mocks: MockRegistry
  /** The loader's resolver (D34): `@provino/mock` never builds one. */
  readonly resolver: Resolver
  /** Directories whose `__mocks__` hold root mocks (Jest `roots`); the first also roots error paths. */
  readonly roots: readonly string[]
  /** Extensions a manual mock may have (`.ts` or `ts`). */
  readonly extensions: readonly string[]
  /** Resolution conditions for `register`'s resolve (default none: the resolver's own). */
  readonly conditions?: readonly string[]
  /** Loads a module's real exports (and a manual mock's file), bypassing the registry. */
  readonly loadActual: (id: string, importer: string) => unknown
}

/**
 * One test file's module-mock registry.
 * @public
 */
export interface ModuleMockRegistry {
  /**
   * `jest.mock`/`vi.mock`/`unmock` and their `do` forms. Resolves at once (kind `mock`) and
   * throws the dialect's `module-missing` text for a missing module without `virtual`, under
   * `requireVirtualFlag`. Registering an id again replaces its entry and drops its cached value.
   */
  register(specifier: string, spec: MockSpec, options: RegisterOptions): void
  /**
   * Whether an import edge is mocked, by Track 4 L342's precedence: explicit unmock, explicit
   * registration, automock-all, root `__mocks__` (when `rootMocksAutoApply`). A pure lookup.
   * `specifier` is the text as written, for the root-mock name; without it a `node_modules` path
   * stands in.
   */
  decide(
    resolvedId: string,
    importer: string,
    kind: 'esm' | 'cjs' | 'builtin',
    specifier?: string,
  ): MockDecision
  /** The same for a specifier that didn't resolve: a virtual module, or a root-mocked package that isn't installed. */
  decideUnresolved(specifier: string, importer: string): MockDecision
  /**
   * The mock's value, built once and cached (per isolation overlay). A Promise under
   * `awaitFactory`, or when `loadActual` returns one.
   */
  materialize(id: string): unknown
  /** `resetModules()`: drops cached values when `resetModulesReRunsFactory`. */
  onResetModules(): void
  /** Turns automock-all on or off (`enableAutomock`/`disableAutomock`); starts at `policy.automock`. */
  setAutomock(enabled: boolean): void
  /**
   * Opens `isolateModules`'s overlay: reads cascade to the outer values, writes stay inside.
   * Throws the dialect's `nested-isolation` text if one is open. The names fill that text.
   */
  enterIsolation(caller?: string, other?: string): void
  exitIsolation(): void
  /** Forgets everything; further calls throw. */
  dispose(): void
}

interface Entry {
  readonly spec: MockSpec
  readonly specifier: string
  readonly from: string
  /** The resolved file, for the adjacent `__mocks__` search; `null` for a builtin or a virtual id. */
  readonly resolved: string | null
}

const NOT_MOCKED: MockDecision = Object.freeze({ mocked: false })

// The names @vitest/vitest's `filterPublicKeys` lets through without an error
// (runtime/moduleRunner/moduleMocker.ts L37-L52).
const PUBLIC_SYMBOLS: ReadonlySet<symbol> = new Set([
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.iterator,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.split,
  Symbol.species,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.unscopables,
])

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** `pkg` or `@scope/pkg` from the last `node_modules` in a path, or `null`. */
function packageNameOf(path: string): string | null {
  const parts = path.split(sep === '\\' ? /[\\/]/ : '/')
  const at = parts.lastIndexOf('node_modules')
  const first = parts[at + 1]
  if (at === -1 || first === undefined || first === '') return null
  if (!first.startsWith('@')) return first
  const second = parts[at + 2]
  return second === undefined || second === '' ? null : `${first}/${second}`
}

function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(specifier)
  )
}

class Registry implements ModuleMockRegistry {
  readonly #options: ModuleMockRegistryOptions
  readonly #policy: ModulePolicy
  readonly #entries = new Map<string, Entry>()
  /** Root mocks for packages that aren't installed, found by `decideUnresolved`. */
  readonly #implicit = new Map<string, ManualMock>()
  readonly #values = new Map<string, unknown>()
  #overlay: Map<string, unknown> | null = null
  readonly #manual = new Map<string, ManualMock | null>()
  readonly #rootNames = new Map<string, boolean>()
  #automock: boolean
  #disposed = false

  constructor(options: ModuleMockRegistryOptions) {
    this.#options = options
    this.#policy = options.policy
    this.#automock = options.policy.automock
  }

  register(specifier: string, spec: MockSpec, options: RegisterOptions): void {
    this.#live()
    const { id, resolved } = this.#identify(specifier, options.from, options.virtual === true, spec)
    this.#entries.set(id, { spec, specifier, from: options.from, resolved })
    this.#manual.delete(id)
    this.#values.delete(id)
    this.#overlay?.delete(id)
  }

  decide(
    resolvedId: string,
    _importer: string,
    kind: 'esm' | 'cjs' | 'builtin',
    specifier?: string,
  ): MockDecision {
    const entry = this.#entries.get(resolvedId)
    if (entry !== undefined) {
      return entry.spec.kind === 'unmock' ? NOT_MOCKED : { mocked: true, id: resolvedId }
    }
    // Core modules are mocked only by an explicit call: never by automock-all or a root mock.
    if (kind === 'builtin') return NOT_MOCKED
    if (this.#automock && !this.#unmockedByPattern(resolvedId)) {
      return { mocked: true, id: resolvedId }
    }
    if (this.#policy.rootMocksAutoApply) {
      const name =
        specifier !== undefined && isBareSpecifier(specifier)
          ? specifier
          : packageNameOf(resolvedId)
      if (name !== null && this.#hasRootMock(name)) return { mocked: true, id: resolvedId }
    }
    return NOT_MOCKED
  }

  decideUnresolved(specifier: string, importer: string): MockDecision {
    if (isCoreSpecifier(specifier))
      return this.decide(`node:${coreName(specifier)}`, importer, 'builtin')
    const id = this.#virtualId(specifier, importer)
    const entry = this.#entries.get(id)
    if (entry !== undefined) {
      if (entry.spec.kind === 'unmock') return NOT_MOCKED
      if (!this.#policy.virtualRelative && !isBareSpecifier(specifier)) {
        const shown = relative(this.#options.roots[0] ?? '', id.slice('virtual:'.length))
        throw new Error(
          this.#text('unresolved-relative-mock', { id: `/${shown.split(sep).join('/')}` }),
        )
      }
      return { mocked: true, id }
    }
    if (this.#implicit.has(id)) return { mocked: true, id }
    if (this.#policy.rootMocksAutoApply && isBareSpecifier(specifier)) {
      const found = findRootMock(specifier, this.#options)
      if (found !== null) {
        this.#implicit.set(id, found)
        return { mocked: true, id }
      }
    }
    return NOT_MOCKED
  }

  materialize(id: string): unknown {
    this.#live()
    const overlay = this.#overlay
    if (overlay?.has(id)) return overlay.get(id)
    if (this.#values.has(id)) return this.#values.get(id)
    const value = this.#create(id)
    ;(overlay ?? this.#values).set(id, value)
    if (isThenable(value)) {
      // A failed build is not cached, as @vitest/mocker's `ManualMockedModule.resolve` doesn't.
      const store = overlay ?? this.#values
      Promise.resolve(value).catch(() => {
        if (store.get(id) === value) store.delete(id)
      })
    }
    return value
  }

  onResetModules(): void {
    this.#live()
    if (this.#policy.resetModulesClearsMocks) {
      this.#entries.clear()
      this.#implicit.clear()
      this.#manual.clear()
    }
    if (this.#policy.resetModulesReRunsFactory || this.#policy.resetModulesClearsMocks) {
      this.#values.clear()
      this.#overlay?.clear()
    }
  }

  setAutomock(enabled: boolean): void {
    this.#live()
    this.#automock = enabled
  }

  enterIsolation(caller = 'isolateModules', other = 'isolateModulesAsync'): void {
    this.#live()
    if (this.#overlay !== null) {
      throw new Error(this.#text('nested-isolation', { caller, other }))
    }
    this.#overlay = new Map()
  }

  exitIsolation(): void {
    this.#live()
    this.#overlay = null
  }

  dispose(): void {
    this.#disposed = true
    this.#entries.clear()
    this.#implicit.clear()
    this.#values.clear()
    this.#manual.clear()
    this.#rootNames.clear()
    this.#overlay = null
  }

  // ---- internals ----

  #live(): void {
    if (this.#disposed)
      throw new MockError('registry-disposed', this.#text('registry-disposed', {}))
  }

  #text(code: ModuleMessageCode, values: Readonly<Record<string, string>>): string {
    return moduleMessage(this.#policy, code, values)
  }

  #virtualId(specifier: string, from: string): string {
    return `virtual:${isBareSpecifier(specifier) ? specifier : resolve(dirname(from), specifier)}`
  }

  /** Resolves a registration's target to the id the loader will ask about. */
  #identify(
    specifier: string,
    from: string,
    virtual: boolean,
    spec: MockSpec,
  ): { readonly id: string; readonly resolved: string | null } {
    if (isCoreSpecifier(specifier)) return { id: `node:${coreName(specifier)}`, resolved: null }
    const result: ResolveResult = this.#options.resolver.resolve(specifier, {
      importer: from,
      kind: 'mock',
      conditions: this.#options.conditions ?? [],
    })
    switch (result.type) {
      case 'file':
        return { id: result.path, resolved: result.path }
      case 'builtin':
        return { id: result.id, resolved: null }
      case 'virtual':
        return { id: `virtual:${specifier}`, resolved: null }
      case 'not-found': {
        // An unmock of a missing module is harmless, and a root mock stands in for a package that
        // isn't installed; anything else needs the flag when the dialect asks for it.
        const allowed =
          virtual ||
          !this.#policy.requireVirtualFlag ||
          spec.kind === 'unmock' ||
          (this.#policy.rootMocksAutoApply &&
            isBareSpecifier(specifier) &&
            findRootMock(specifier, this.#options) !== null)
        if (!allowed) {
          throw new MockError(
            'module-missing',
            this.#text('module-missing', { specifier, from: this.#displayPath(from) }),
          )
        }
        return { id: this.#virtualId(specifier, from), resolved: null }
      }
    }
  }

  /** The importer relative to the first root, with `/` separators and `.` for the root itself. */
  #displayPath(from: string): string {
    const root = this.#options.roots[0]
    const shown = root === undefined ? from : relative(root, from)
    return shown === '' ? '.' : shown.split(sep).join('/')
  }

  #unmockedByPattern(path: string): boolean {
    for (const pattern of this.#policy.unmockedPathPatterns) {
      pattern.lastIndex = 0
      if (pattern.test(path)) return true
    }
    return false
  }

  #hasRootMock(name: string): boolean {
    let found = this.#rootNames.get(name)
    if (found === undefined) {
      found = findRootMock(name, this.#options) !== null
      this.#rootNames.set(name, found)
    }
    return found
  }

  /** A manual mock for `id`, by the entry's specifier or, with no entry, the package its path is in. */
  #manualFor(id: string, entry: Entry | undefined): ManualMock | null {
    const cached = this.#manual.get(id)
    if (cached !== undefined) return cached
    const specifier = entry?.specifier ?? packageNameOf(id)
    const found = findManualMock(specifier ?? id, {
      roots: this.#options.roots,
      extensions: this.#options.extensions,
      resolved: entry !== undefined ? entry.resolved : isAbsolute(id) ? id : null,
    })
    this.#manual.set(id, found)
    return found
  }

  #create(id: string): unknown {
    const entry = this.#entries.get(id)
    if (entry === undefined) {
      const implicit = this.#implicit.get(id)
      if (implicit !== undefined) return this.#options.loadActual(implicit.path, '')
      const manual = this.#manualFor(id, undefined)
      if (manual !== null) return this.#options.loadActual(manual.path, '')
      return this.#automockOf(id, '', false)
    }
    const spec = entry.spec
    switch (spec.kind) {
      case 'factory':
        return this.#runFactory(id, entry, spec.factory)
      case 'redirect':
        return this.#options.loadActual(spec.to, entry.from)
      case 'automock': {
        // `mock(p)` prefers a manual mock; a spy (`{ spy: true }`) never does.
        if (!spec.spy) {
          const manual = this.#manualFor(id, entry)
          if (manual !== null) return this.#options.loadActual(manual.path, entry.from)
        }
        return this.#automockOf(id, entry.from, spec.spy)
      }
      case 'unmock':
        return this.#options.loadActual(id, entry.from)
    }
  }

  #automockOf(id: string, from: string, spy: boolean): unknown {
    const options = this.#options
    const build = (actual: unknown): unknown => {
      try {
        return automock(actual, this.#policy.automockShape, spy ? 'autospy' : 'automock', (o) =>
          createMockFn(options.mockPolicy, options.mocks, o),
        )
      } catch (error) {
        if (error instanceof MockError && error.code === 'automock-no-metadata') {
          throw new MockError(error.code, this.#text('automock-no-metadata', { id }))
        }
        throw error
      }
    }
    const actual = options.loadActual(id, from)
    return isThenable(actual) ? Promise.resolve(actual).then(build) : build(actual)
  }

  #runFactory(
    id: string,
    entry: Entry,
    factory: (importOriginal: () => Promise<unknown>) => unknown,
  ): unknown {
    const importOriginal = (): Promise<unknown> =>
      new Promise((done) => {
        done(this.#options.loadActual(entry.resolved ?? id, entry.from))
      })
    const wrap = this.#policy.messages['factory-error']
    const helpful = (cause: unknown): unknown =>
      wrap === undefined ? cause : new Error(wrap, { cause })
    let result: unknown
    try {
      result = factory(importOriginal)
    } catch (error) {
      throw helpful(error)
    }
    if (this.#policy.awaitFactory) {
      return Promise.resolve(result).then(
        (value) => this.#shape(value, entry),
        (error: unknown) => {
          throw helpful(error)
        },
      )
    }
    return this.#shape(result, entry)
  }

  /** `factoryShape` and `missingFactoryExport`: what the consumer sees of the factory's result. */
  #shape(value: unknown, entry: Entry): unknown {
    const policy = this.#policy
    if (
      policy.factoryShape === 'namespace' &&
      (value === null || typeof value !== 'object' || Array.isArray(value))
    ) {
      throw new MockTypeError(
        'factory-not-object',
        this.#text('factory-not-object', { raw: entry.specifier }),
      )
    }
    // A Proxy only where a read must throw, so the Jest path pays nothing for it.
    if (policy.missingFactoryExport !== 'throw' || !isObjectLike(value) || isThenable(value)) {
      return value
    }
    const raw = entry.specifier
    return new Proxy(value, {
      get: (target, prop, receiver): unknown => {
        if (prop in target || prop === 'then' || prop === '__esModule') {
          return Reflect.get(target, prop, receiver)
        }
        if (typeof prop === 'symbol' && PUBLIC_SYMBOLS.has(prop)) return undefined
        throw new Error(this.#text('missing-factory-export', { name: String(prop), raw }))
      },
    })
  }
}

/**
 * Creates a test file's module-mock registry. It never imports a dialect: every difference between
 * Jest and Vitest is a key of `options.policy`.
 * @public
 */
export function createModuleMockRegistry(options: ModuleMockRegistryOptions): ModuleMockRegistry {
  return new Registry(options)
}
