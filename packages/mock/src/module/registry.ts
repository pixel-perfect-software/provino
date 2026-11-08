// The module-mock registry (T4.7): one per test file. The loader asks `decide` once per import edge
// and `materialize` for a mocked id; `@provino/mock` owns everything between (registrations,
// `__mocks__` discovery, the factory's result per policy, automock, the isolation overlay).
//
// Brief B13b Gaps 4-6 shape it: the resolver is injected (D34), so `register` resolves at once and
// there is no queue and no `flush`; a virtual module's id stays inside the registry as
// `virtual:<specifier>`; the factory's result shape and missing-export behaviour are policy keys.
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  MockPolicy,
  MockSpec,
  ModulePolicy,
  ResolveKind,
  ResolveResult,
  Resolver,
} from '@provino/types'
import { MockError, MockTypeError } from '../errors.ts'
import { isObjectLike, isThenable } from '../internal/guards.ts'
import { createMockFn } from '../mock-fn.ts'
import type { MockRegistry } from '../registry.ts'
import { automock } from './automock.ts'
import {
  coreName,
  findManualMock,
  findRootMock,
  isBareSpecifier,
  isCoreSpecifier,
  type ManualMock,
  rootsWithMocks,
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
   * registration, automock-all, root `__mocks__` (when `rootMocksAutoApply`). It changes nothing
   * the answer depends on; it only remembers the specifier for `materialize`'s manual-mock name.
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
  /** `resetModules()`: drops cached values when the module registry owns them (`mockValueOwner`). */
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

class Registry implements ModuleMockRegistry {
  readonly #options: ModuleMockRegistryOptions
  readonly #policy: ModulePolicy
  readonly #entries = new Map<string, Entry>()
  /** The id a dual package's other ids stand for: one entry, one cached value. */
  readonly #canonical = new Map<string, string>()
  /** The bare specifier `decide` saw for an id that has no entry, for its manual-mock name. */
  readonly #specifiers = new Map<string, string>()
  /** Ids whose value is being built (a factory still running or pending). */
  readonly #building = new Set<string>()
  /** The ids whose factory the current call stack, or async continuation, is inside; made on the first factory. */
  #inside: AsyncLocalStorage<ReadonlySet<string>> | null = null
  readonly #values = new Map<string, unknown>()
  #overlay: Map<string, unknown> | null = null
  /** Manual mocks by id; a root mock for an uninstalled package is seeded here by `decideUnresolved`. */
  readonly #manual = new Map<string, ManualMock | null>()
  /** `findRootMock` by name, misses included. */
  readonly #rootMocks = new Map<string, ManualMock | null>()
  /** The roots that have a `__mocks__` directory, found on first use. */
  #mockRoots: readonly string[] | null = null
  #automock: boolean
  #disposed = false

  constructor(options: ModuleMockRegistryOptions) {
    this.#options = options
    this.#policy = options.policy
    this.#automock = options.policy.automock
  }

  register(specifier: string, spec: MockSpec, options: RegisterOptions): void {
    this.#live()
    const targets = this.#identify(specifier, options.from, options.virtual === true, spec)
    const [primary] = targets
    if (primary === undefined) return
    // One entry for every id the specifier resolves to (a dual package's `import` and `require`
    // files), and one cached value: the first id stands for the group.
    const entry: Entry = { spec, specifier, from: options.from }
    for (const id of targets) {
      this.#entries.set(id, entry)
      this.#canonical.set(id, primary)
      this.#manual.delete(id)
      // A second registration drops the value already built only if the registration owns it.
      if (this.#policy.mockValueOwner === 'registration') {
        this.#values.delete(id)
        this.#overlay?.delete(id)
      }
    }
  }

  decide(
    resolvedId: string,
    _importer: string, // Jest's transitive `node_modules` rule would need it (not built).
    kind: 'esm' | 'cjs' | 'builtin',
    specifier?: string,
  ): MockDecision {
    this.#live()
    const entry = this.#entries.get(resolvedId)
    if (entry !== undefined) {
      return entry.spec.kind === 'unmock'
        ? NOT_MOCKED
        : { mocked: true, id: this.#canonical.get(resolvedId) ?? resolvedId }
    }
    // Core modules are mocked only by an explicit call: never by automock-all or a root mock.
    if (kind === 'builtin') return NOT_MOCKED
    if (this.#automock && !this.#unmockedByPattern(resolvedId)) {
      this.#noteSpecifier(resolvedId, specifier)
      return { mocked: true, id: resolvedId }
    }
    if (this.#policy.rootMocksAutoApply) {
      // A specifier as written names the root mock (`pkg/sub` is `__mocks__/pkg/sub`, a relative
      // import has none); without one the package in the path stands in.
      const name =
        specifier === undefined
          ? packageNameOf(resolvedId)
          : isBareSpecifier(specifier)
            ? specifier
            : null
      if (name !== null && this.#hasRootMock(name)) {
        this.#noteSpecifier(resolvedId, specifier)
        return { mocked: true, id: resolvedId }
      }
    }
    return NOT_MOCKED
  }

  decideUnresolved(specifier: string, importer: string): MockDecision {
    this.#live()
    if (isCoreSpecifier(specifier))
      return this.decide(`node:${coreName(specifier)}`, importer, 'builtin')
    const id = this.#virtualId(specifier, importer)
    const entry = this.#entries.get(id)
    if (entry !== undefined) {
      if (entry.spec.kind === 'unmock') return NOT_MOCKED
      if (!this.#policy.virtualRelative && !isBareSpecifier(specifier)) {
        const shown = relative(this.#options.roots[0] ?? '', id.slice('virtual:'.length))
        throw new MockError(
          'unresolved-relative-mock',
          this.#text('unresolved-relative-mock', { id: `/${shown.split(sep).join('/')}` }),
        )
      }
      return { mocked: true, id }
    }
    if (this.#manual.get(id) != null) return { mocked: true, id }
    if (this.#policy.rootMocksAutoApply && isBareSpecifier(specifier)) {
      const found = this.#rootMock(specifier)
      if (found !== null) {
        this.#manual.set(id, found)
        return { mocked: true, id }
      }
    }
    return NOT_MOCKED
  }

  materialize(requested: string): unknown {
    this.#live()
    const id = this.#canonical.get(requested) ?? requested
    // Asked for from inside its own factory, which is still building it: the answer would be the
    // factory's own result. Real Jest overflows the stack here; the error is the clear form of that.
    if (this.#building.has(id) && this.#inside?.getStore()?.has(id) === true) {
      const error = new MockError(
        'circular-mock',
        this.#text('circular-mock', { raw: this.#entries.get(id)?.specifier ?? id }),
      )
      if (this.#policy.awaitFactory) return Promise.reject(error)
      throw error
    }
    const overlay = this.#overlay
    if (overlay?.has(id)) return overlay.get(id)
    if (this.#values.has(id)) return this.#values.get(id)
    this.#building.add(id)
    let value: unknown
    try {
      value = this.#create(id)
    } catch (error) {
      this.#building.delete(id)
      throw error
    }
    const store = overlay ?? this.#values
    store.set(id, value)
    if (isThenable(value)) {
      // A failed build is not cached, as @vitest/mocker's `ManualMockedModule.resolve` doesn't.
      const settled = (): void => {
        this.#building.delete(id)
      }
      Promise.resolve(value).then(settled, () => {
        settled()
        if (store.get(id) === value) store.delete(id)
      })
    } else {
      this.#building.delete(id)
    }
    return value
  }

  onResetModules(): void {
    this.#live()
    if (this.#policy.resetModulesClearsMocks) {
      this.#entries.clear()
      this.#canonical.clear()
      this.#manual.clear()
    }
    if (this.#policy.mockValueOwner === 'module-registry' || this.#policy.resetModulesClearsMocks) {
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
      throw new MockError('nested-isolation', this.#text('nested-isolation', { caller, other }))
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
    this.#canonical.clear()
    this.#specifiers.clear()
    this.#building.clear()
    this.#values.clear()
    this.#manual.clear()
    this.#rootMocks.clear()
    this.#mockRoots = null
    this.#overlay = null
    this.#inside?.disable()
    this.#inside = null
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
  #identify(specifier: string, from: string, virtual: boolean, spec: MockSpec): readonly string[] {
    if (isCoreSpecifier(specifier)) return [`node:${coreName(specifier)}`]
    const resolve = (kind: ResolveKind): ResolveResult =>
      this.#options.resolver.resolve(specifier, {
        importer: from,
        kind,
        conditions: this.#options.conditions ?? [],
      })
    const result = resolve('mock')
    switch (result.type) {
      case 'file': {
        // A dual package resolves to one file for `import` and another for `require`: the mock
        // covers both, as `FileRegistry.invalidate` does. A kind that doesn't resolve is skipped.
        // Conditions can't change where a relative or absolute path points, so only a bare one asks.
        const targets = [result.path]
        if (!isBareSpecifier(specifier)) return targets
        for (const kind of ['import', 'require'] as const) {
          const other = resolve(kind)
          if (other.type === 'file' && !targets.includes(other.path)) targets.push(other.path)
        }
        return targets
      }
      case 'builtin':
        return [result.id]
      case 'virtual':
        return [`virtual:${specifier}`]
      case 'not-found': {
        // A root mock stands in for a package that isn't installed; anything else, an unmock
        // included (`mod-unmock-missing`), needs the flag when the dialect asks for it.
        const allowed =
          virtual ||
          !this.#policy.requireVirtualFlag ||
          (this.#policy.rootMocksAutoApply &&
            isBareSpecifier(specifier) &&
            this.#rootMock(specifier) !== null)
        if (!allowed) {
          throw new MockError(
            'module-missing',
            this.#text(spec.kind === 'unmock' ? 'unmock-module-missing' : 'module-missing', {
              specifier,
              from: this.#displayPath(from),
            }),
          )
        }
        return [this.#virtualId(specifier, from)]
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

  #rootsWithMocks(): readonly string[] {
    this.#mockRoots ??= rootsWithMocks(this.#options.roots)
    return this.#mockRoots
  }

  #chains(): AsyncLocalStorage<ReadonlySet<string>> {
    this.#inside ??= new AsyncLocalStorage()
    return this.#inside
  }

  #hasRootMock(name: string): boolean {
    return this.#rootMock(name) !== null
  }

  /** The root mock of a package name, found once per name (a miss is remembered too). */
  #rootMock(name: string): ManualMock | null {
    let found = this.#rootMocks.get(name)
    if (found === undefined) {
      found = findRootMock(name, {
        roots: this.#rootsWithMocks(),
        extensions: this.#options.extensions,
      })
      this.#rootMocks.set(name, found)
    }
    return found
  }

  /** Remembers the specifier `decide` was given for `id`: a bare one wins over a relative one. */
  #noteSpecifier(id: string, specifier: string | undefined): void {
    if (specifier === undefined) return
    const known = this.#specifiers.get(id)
    if (known === undefined || (!isBareSpecifier(known) && isBareSpecifier(specifier))) {
      this.#specifiers.set(id, specifier)
    }
  }

  /** A manual mock for `id`, by the entry's specifier or, with no entry, the package its path is in. */
  #manualFor(id: string, entry: Entry | undefined): ManualMock | null {
    const cached = this.#manual.get(id)
    if (cached !== undefined) return cached
    // Never re-derived from the path when a specifier was given: `pkg/sub` is not `pkg`.
    const specifier = entry?.specifier ?? this.#specifiers.get(id) ?? packageNameOf(id)
    const found = findManualMock(specifier ?? id, {
      roots: this.#rootsWithMocks(),
      extensions: this.#options.extensions,
      // A resolved file is its own id; a builtin or virtual id has no file to search beside.
      resolved: isAbsolute(id) ? id : null,
    })
    this.#manual.set(id, found)
    return found
  }

  #create(id: string): unknown {
    const entry = this.#entries.get(id)
    if (entry === undefined) {
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
        done(this.#options.loadActual(id, entry.from))
      })
    const wrap = this.#policy.messages['factory-error']
    const helpful = (cause: unknown): unknown =>
      wrap === undefined ? cause : new Error(wrap, { cause })
    let result: unknown
    try {
      const inside = this.#chains()
      const chain = new Set(inside.getStore())
      chain.add(id)
      result = inside.run(chain, () => factory(importOriginal))
    } catch (error) {
      // Under `awaitFactory` every failure is a rejection, a synchronous throw included.
      if (this.#policy.awaitFactory) return Promise.reject(helpful(error))
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
        throw new MockError(
          'missing-factory-export',
          this.#text('missing-factory-export', { name: String(prop), raw }),
        )
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
