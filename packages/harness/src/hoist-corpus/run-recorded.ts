// Runs a hoisted module against recording stubs, so the hoist corpus can see what `orderOf` can't: a
// binding lost in a rewrite, a factory that reads a `const` in its TDZ, a value frozen at load, the
// `this` of a call through an import. Every hoister's output gets the same stubs and its real next
// step, then the logs are compared line by line.
//
// How a free name resolves: the code runs inside `with (scope)`, in a strict function below it, and
// `scope` answers for every name that isn't a real JavaScript built-in. So `foo()` in a fixture needs
// no setup and is logged, and a stale `x` the hoister forgot to rewrite shows as a read of the global
// `x`, not as a crash that a `catch` might hide.
//
// What the stubs do so that shapes that aren't behaviour don't show, each for a named reason:
// - A namespace says `__esModule: true`, so Babel's interop helpers return it untouched and
//   `_interopRequireDefault`'s wrapper never appears. The reads of `__esModule` and `then` (every
//   `await` of a namespace reads it) aren't logged.
// - A module is logged the first time it loads and after a mock call changes it. Babel merges two
//   imports of one module into one `require`, the module-runner form keeps both, and the second is
//   a cache hit under every runner.
// - `react/jsx*` calls log only the element type: the other arguments hold source positions, which
//   two parsers count differently.
// - Import attributes go in `loadOptions`, not the log: Babel's CJS step and Vitest's rewritten
//   import both drop them, and ours keeps them (see the test `import attributes survive`).

import { errorMessage } from '../internal/guards.ts'

const MAX_LINES = 5000
const MAX_CALLBACKS = 200

/** Each runner's own object and modules: fixed here, never read from a policy under test. */
const RUNNERS = {
  jest: { objects: ['jest'], modules: ['@jest/globals'] },
  vitest: { objects: ['vi', 'vitest'], modules: ['vitest', 'vite-plus/test'] },
} as const

export type RunnerName = keyof typeof RUNNERS

/**
 * JavaScript's own names: `with (scope)` lets these through, and answers for every other. `Math` and
 * `Date` aren't here: a stub keeps a log deterministic where a real clock or `Math.random` wouldn't.
 */
const BUILT_INS = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'Error',
  'Function',
  'Infinity',
  'JSON',
  'Map',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'WeakMap',
  'WeakSet',
  'decodeURIComponent',
  'encodeURIComponent',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
])

const MOCKING_METHODS = new Set(['mock', 'doMock'])
const UNMOCKING_METHODS = new Set(['unmock', 'doUnmock', 'dontMock', 'deepUnmock'])
const CHAINABLE_METHODS = new Set(['enableAutomock', 'disableAutomock'])

/** The keys a namespace reports when no factory gave it its own, as `export *` sees them. */
const DEFAULT_KEYS = ['a', 'b', 'default']

export interface RunLog {
  readonly lines: readonly string[]
  /** The options of each `import()` that had any, as `<specifier> <json>`. */
  readonly loadOptions: readonly string[]
  /** The `SyntaxError` when the code doesn't compile, for the caller to name the side that failed. */
  readonly compileError: string | undefined
  readonly truncated: boolean
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : `non-error ${String(error)}`
}

/** Thrown when a run's log hits its cap: a stub in a loop condition is always truthy. */
class RunawayRun extends Error {
  override readonly name = 'RunawayRun'
}

interface MockEntry {
  /** `undefined` for a call with no factory. */
  readonly factory: ((...args: readonly unknown[]) => unknown) | undefined
  readonly unmock: boolean
  ran: boolean
}

type Callable = (...args: readonly unknown[]) => unknown

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function'
}

/** One run's stubs. All state is here: a run shares nothing with another. */
class Recording {
  readonly lines: string[] = []
  readonly loadOptions: string[] = []
  truncated = false
  readonly exports: Record<string, unknown> = {}
  readonly #labels = new WeakMap<object, string>()
  readonly #values = new Map<string, object>()
  readonly #registry = new Map<string, MockEntry>()
  readonly #cache = new Map<string, object>()
  readonly #loading = new Set<string>()
  readonly #callbacks: { readonly label: string; readonly fn: Callable }[] = []
  readonly #runner: RunnerName
  readonly #objects: ReadonlyMap<string, object>
  /** Bumped between the two reads of the exports: a live binding moves, a frozen one doesn't. */
  #version = 1

  constructor(runner: RunnerName) {
    this.#runner = runner
    this.#objects = new Map(RUNNERS[runner].objects.map((name) => [name, this.#mockObject(name)]))
  }

  log(line: string): void {
    if (this.lines.length >= MAX_LINES) {
      this.truncated = true
      throw new RunawayRun(`more than ${MAX_LINES} log lines`)
    }
    this.lines.push(line)
  }

  /** A log line that must land even when the run is over its cap. */
  note(line: string): void {
    if (this.lines.length < MAX_LINES) this.lines.push(line)
  }

  describe(value: unknown, depth = 0): string {
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'symbol') return value.toString()
    if ((value === null || typeof value !== 'object') && typeof value !== 'function') {
      return String(value)
    }
    const object = value as object
    const label = this.#labels.get(object)
    if (label !== undefined) return `<${label}>`
    if (typeof object === 'function') return `fn/${(object as Callable).length}`
    if (object instanceof Promise) return 'Promise'
    if (object instanceof Error) return `Error(${object.name})`
    if (depth >= 3) return '…'
    if (Array.isArray(object)) {
      return `[${object.map((item) => this.describe(item, depth + 1)).join(', ')}]`
    }
    const entries = Object.keys(object).map((key) => {
      return `${key}: ${this.describe(Reflect.get(object, key), depth + 1)}`
    })
    return `{${entries.join(', ')}}`
  }

  #describeAll(args: readonly unknown[]): string {
    return args.map((arg) => this.describe(arg)).join(', ')
  }

  /** A function handed to a stub runs after the body, so a stale name in a test callback shows. */
  #defer(label: string, args: readonly unknown[]): void {
    args.forEach((arg, index) => {
      if (isCallable(arg) && !this.#labels.has(arg)) {
        this.#callbacks.push({ label: `${label}[${index}]`, fn: arg })
      }
    })
  }

  /** A callable, constructible value that logs everything done to it. One per label. */
  value(label: string): object {
    const known = this.#values.get(label)
    if (known !== undefined) return known
    const isJsx = label.startsWith('react/jsx')
    const target = function stub(): void {}
    const proxy = new Proxy(target, {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') return this.#symbolValue(label, prop)
        if (prop === 'then' || prop === '__esModule') return undefined
        if (prop === 'prototype') return this.value(`${label}.prototype`)
        this.log(`read ${label}.${prop}`)
        return this.value(`${label}.${prop}`)
      },
      set: (_target, prop, next) => {
        this.log(`set ${label}.${String(prop)} = ${this.describe(next)}`)
        return true
      },
      apply: (_target, self: unknown, args: readonly unknown[]) => {
        const shown = isJsx ? args.slice(0, 1) : args
        this.log(`call ${label}(${this.#describeAll(shown)}) this=${this.describe(self)}`)
        this.#defer(label, args)
        return this.value(`${label}()`)
      },
      construct: (_target, args: readonly unknown[]) => {
        this.log(`new ${label}(${this.#describeAll(args)})`)
        this.#defer(label, args)
        return this.value(`new ${label}()`)
      },
    })
    this.#labels.set(proxy, label)
    this.#values.set(label, proxy)
    return proxy
  }

  #symbolValue(label: string, prop: symbol): unknown {
    if (prop === Symbol.toPrimitive) return () => `<${label}>`
    if (prop === Symbol.iterator) return () => [][Symbol.iterator]()
    return undefined
  }

  /** `jest`, `vi`: logs each call, keeps a registry of what is mocked, and runs `vi.hoisted`. */
  #mockObject(name: string): object {
    const target = function stub(): void {}
    const methods = new Map<string, Callable>()
    const proxy: object = new Proxy(target, {
      get: (_target, prop) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined
        const known = methods.get(prop)
        if (known !== undefined) return known
        const method: Callable = (...args) => this.#mockCall(name, prop, args, proxy)
        methods.set(prop, method)
        return method
      },
    })
    this.#labels.set(proxy, name)
    return proxy
  }

  #mockCall(name: string, method: string, args: readonly unknown[], self: object): unknown {
    this.log(`${name}.${method}(${this.#describeAll(args)})`)
    const first = args[0]
    const specifier = typeof first === 'string' ? first : this.describe(first)
    if (MOCKING_METHODS.has(method)) {
      const factory = args[1]
      this.#registry.set(specifier, {
        factory: isCallable(factory) ? factory : undefined,
        unmock: false,
        ran: false,
      })
      this.#cache.delete(specifier)
      return self
    }
    if (UNMOCKING_METHODS.has(method)) {
      this.#registry.set(specifier, { factory: undefined, unmock: true, ran: false })
      this.#cache.delete(specifier)
      return self
    }
    if (CHAINABLE_METHODS.has(method)) return self
    if (method === 'hoisted' && isCallable(first)) return first()
    this.#defer(`${name}.${method}`, args)
    return this.value(`${name}.${method}()`)
  }

  #namespace(specifier: string, overlay: object | null): object {
    const keys = overlay === null ? DEFAULT_KEYS : Object.keys(overlay)
    const label = `ns:${specifier}`
    const proxy = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop === 'symbol') return undefined
          if (prop === '__esModule') return true
          if (prop === 'then') return undefined
          this.log(`read ${specifier}.${prop}`)
          if (overlay !== null && Object.hasOwn(overlay, prop)) return Reflect.get(overlay, prop)
          const version = this.#version === 1 ? '' : `@${this.#version}`
          return this.value(`${specifier}.${prop}${version}`)
        },
        set: (_target, prop, next) => {
          this.log(`set ${specifier}.${String(prop)} = ${this.describe(next)}`)
          return true
        },
        ownKeys: () => keys,
        getOwnPropertyDescriptor: (_target, prop) =>
          typeof prop === 'string' && keys.includes(prop)
            ? { configurable: true, enumerable: true, writable: true, value: undefined }
            : undefined,
      },
    )
    this.#labels.set(proxy, label)
    return proxy
  }

  #runnerModule(specifier: string): object {
    const known = this.#cache.get(specifier)
    if (known !== undefined) return known
    const proxy = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop === 'symbol' || prop === 'then') return undefined
          if (prop === '__esModule') return true
          return this.#objects.get(prop) ?? this.value(`${specifier}.${prop}`)
        },
      },
    )
    this.#labels.set(proxy, `ns:${specifier}`)
    this.#cache.set(specifier, proxy)
    return proxy
  }

  #runFactory(specifier: string, entry: MockEntry): object | null {
    const factory = entry.factory
    if (factory === undefined || entry.ran) return null
    entry.ran = true
    this.log(`factory ${specifier} start`)
    try {
      const result = factory(this.value('importOriginal'))
      this.log(`factory ${specifier} returned ${this.describe(result)}`)
      const plain =
        typeof result === 'object' &&
        result !== null &&
        !this.#labels.has(result) &&
        !(result instanceof Promise)
      return plain ? result : null
    } catch (error) {
      this.note(`factory ${specifier} threw ${errorName(error)}`)
      throw error
    }
  }

  load = (specifier: string): object => {
    const modules: readonly string[] = RUNNERS[this.#runner].modules
    if (modules.includes(specifier)) return this.#runnerModule(specifier)
    const cached = this.#cache.get(specifier)
    if (cached !== undefined) return cached
    const entry = this.#registry.get(specifier)
    const state =
      entry === undefined || entry.unmock
        ? 'real'
        : entry.factory === undefined
          ? 'automock'
          : 'factory'
    this.log(`load ${specifier} [${state}]`)
    // A factory that loads its own module gets the real one, as `requireActual` would.
    if (this.#loading.has(specifier)) return this.#namespace(specifier, null)
    this.#loading.add(specifier)
    try {
      const overlay = entry === undefined ? null : this.#runFactory(specifier, entry)
      const namespace = this.#namespace(specifier, overlay)
      this.#cache.set(specifier, namespace)
      return namespace
    } finally {
      this.#loading.delete(specifier)
    }
  }

  /** The names a running module sees that are the runtime's, not the fixture's. */
  #environment(): ReadonlyMap<string, unknown> {
    const moduleObject = { exports: this.exports }
    const importModule = (specifier: unknown): Promise<object> =>
      Promise.resolve().then(() => this.load(String(specifier)))
    return new Map<string, unknown>([
      ['require', (specifier: unknown) => this.load(String(specifier))],
      ['module', moduleObject],
      ['exports', this.exports],
      ['__filename', '/virtual/file.js'],
      ['__dirname', '/virtual'],
      ['__vite_ssr_exports__', this.exports],
      ['__vite_ssr_import_meta__', this.value('import.meta')],
      ['__vite_ssr_import__', importModule],
      [
        '__vite_ssr_dynamic_import__',
        (specifier: unknown, options: unknown) => {
          if (options !== undefined) {
            this.loadOptions.push(`${String(specifier)} ${JSON.stringify(options)}`)
          }
          return importModule(specifier)
        },
      ],
      [
        '__vite_ssr_exportAll__',
        (source: object) => {
          for (const key of Reflect.ownKeys(source)) {
            if (typeof key !== 'string' || key === 'default' || key in this.exports) continue
            Object.defineProperty(this.exports, key, {
              enumerable: true,
              configurable: true,
              get: () => Reflect.get(source, key),
            })
          }
        },
      ],
      ...this.#objects,
    ])
  }

  scope(): object {
    const environment = this.#environment()
    const scope = new Proxy(
      {},
      {
        has: (_target, name) => typeof name === 'string' && !BUILT_INS.has(name),
        get: (_target, name) => {
          if (typeof name !== 'string') return undefined
          if (environment.has(name)) return environment.get(name)
          this.log(`read global ${name}`)
          return this.value(`global.${name}`)
        },
        set: (_target, name, next) => {
          this.log(`set global ${String(name)} = ${this.describe(next)}`)
          return true
        },
      },
    )
    // A call of a free name has the `with` object as its `this`.
    this.#labels.set(scope, 'global')
    return scope
  }

  #exportNames(): readonly string[] {
    return Object.keys(this.exports)
      .filter((key) => key !== '__esModule')
      .sort()
  }

  #readExports(pass: string): void {
    for (const key of this.#exportNames()) {
      try {
        this.log(`export ${pass} ${key} = ${this.describe(this.exports[key])}`)
      } catch (error) {
        this.note(`export ${pass} ${key} threw ${errorName(error)}`)
      }
    }
  }

  #readQuietly(key: string): unknown {
    try {
      return this.exports[key]
    } catch (error) {
      if (error instanceof RunawayRun) throw error
      return undefined
    }
  }

  async #guarded(run: () => unknown, label: string): Promise<void> {
    try {
      const result = await run()
      this.log(`${label} returned ${this.describe(result)}`)
    } catch (error) {
      this.note(`${label} threw ${errorName(error)}`)
    }
  }

  /** Everything after the body: the exports, twice, then what the body only set up. */
  async finish(): Promise<void> {
    try {
      this.#readExports('first')
      this.#version = 2
      this.#readExports('live')
      for (const key of this.#exportNames()) {
        // An export still in its TDZ throws here too; `#readExports` has logged that.
        const value = this.#readQuietly(key)
        if (isCallable(value) && !this.#labels.has(value)) {
          await this.#guarded(value, `exported ${key}()`)
        }
      }
      for (const [specifier, entry] of this.#registry) {
        if (entry.factory === undefined || entry.ran) continue
        try {
          this.#runFactory(specifier, entry)
        } catch (error) {
          // `#runFactory` logged it. Only the cap stops the run.
          if (error instanceof RunawayRun) throw error
        }
      }
      for (let run = 0; run < MAX_CALLBACKS; run++) {
        const next = this.#callbacks.shift()
        if (next === undefined) break
        await this.#guarded(next.fn, `callback ${next.label}`)
      }
    } catch (error) {
      if (!(error instanceof RunawayRun)) throw error
    }
  }
}

function compile(code: string): (scope: object) => Promise<void> {
  // A hashbang is only legal as a file's first line, and this body isn't one.
  const body = code.replace(/^#![^\n]*/, '')
  // The sloppy outer function is what `with` needs; the module itself runs strict, as ESM does.
  const source = `with (__scope) { return (async function () { "use strict";\n${body}\n}).call(undefined) }`
  const compiled: unknown = new Function('__scope', source)
  if (!isCallable(compiled)) throw new Error('Function did not give a function')
  return (scope) => Promise.resolve(compiled(scope)).then(() => undefined)
}

/**
 * Runs `code` (already through its hoister's real next step: CommonJS or module-runner form) and
 * returns what it did. Never throws for what the code does: a throw is a line in the log.
 */
export async function runRecorded(code: string, runner: RunnerName): Promise<RunLog> {
  const recording = new Recording(runner)
  let body: (scope: object) => Promise<void>
  try {
    body = compile(code)
  } catch (error) {
    return {
      lines: [],
      loadOptions: [],
      compileError: errorMessage(error),
      truncated: false,
    }
  }
  try {
    await body(recording.scope())
    recording.log('body done')
  } catch (error) {
    recording.note(`body threw ${errorName(error)}`)
  }
  await recording.finish()
  return {
    lines: recording.lines,
    loadOptions: recording.loadOptions,
    compileError: undefined,
    truncated: recording.truncated,
  }
}
