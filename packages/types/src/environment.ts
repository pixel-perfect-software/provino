// Track 8 §Types → Environment contract. The Jest and Vitest adapters live in the dialects
// (Track 11); `defineEnvironment` and `environment` are implemented where environments are
// (B10), typed by the signatures here. Track 8's `TestEventLike` placeholder is `RuntimeEvent`:
// Track 5 owns the real type.
import type { Context } from 'node:vm'
import type { JsonValue } from './clone-safe.ts'
import type { RuntimeEvent } from './runtime/events.ts'

/**
 * Which realm an environment's globals live in: the worker's own (`registry` and `none` tiers)
 * or a vm context (`realm` tier).
 * @public
 */
export type EnvironmentRealm = 'worker' | 'context'

/**
 * How long one environment instance lives: one file, or the whole worker (isolation `none`).
 * @public
 */
export type EnvironmentScope = 'file' | 'worker'

/**
 * A file's docblock pragmas by name without the `@`: a pragma with no value is `''`, and one given
 * twice or more holds every value in order.
 * @public
 */
export type Pragmas = Readonly<Record<string, string | readonly string[]>>

/**
 * The `process` a test file sees (the policy's `orchestrator.processObject`): `per-file`, a copy
 * of the worker's with listeners and an `env` of its own, or `shared`, the worker's own.
 * @public
 */
export type ProcessObject = 'per-file' | 'shared'

/**
 * What an environment's `setup` receives.
 * @public
 */
export interface EnvironmentSetupContext<Options> {
  readonly options: Options
  readonly realm: EnvironmentRealm
  readonly scope: EnvironmentScope
  readonly testPath: string
  /** The file's docblock pragmas. */
  readonly pragmas: Pragmas
  readonly console: Console
  /** Aborted when the worker cancels. */
  readonly signal: AbortSignal
  /**
   * The `process` to install on the global for the file (`orchestrator.processObject`): with
   * `per-file` the environment installs a copy of the worker's for the file (scope `worker`: one
   * for the worker) and puts the worker's back at teardown. Absent: `shared`.
   */
  readonly processObject?: ProcessObject
}

/**
 * What a `teardown` reports when it left something behind (decision D22): an unremovable global is
 * a warning, not a failure. The file passes; the worker warns and tells the coordinator, which
 * recycles the worker.
 * @public
 */
export interface EnvironmentTeardownReport {
  /** Global keys the teardown could not restore, as strings (`String(symbol)` for a symbol key): a key a test added that can't be deleted, or a changed key that can't be redefined. Later files in this worker still see them. */
  readonly leakedGlobals: readonly string[]
}

/**
 * A set-up environment.
 * @public
 */
export interface EnvironmentInstance<G extends object = typeof globalThis> {
  /** What test code sees as `globalThis`. */
  readonly global: G
  /** Present exactly when the realm is `context`. */
  readonly context?: Context
  /** Jest's `handleTestEvent`: sees every runtime event of the file. */
  onTestEvent?(event: RuntimeEvent): void | Promise<void>
  /**
   * Puts the global back. Returning nothing means a clean teardown; returning a report means it
   * restored everything it could and names the keys it could not. Throw only for an unexpected
   * failure, which fails the file.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: `Promise<void>` from an `async teardown() {}` must stay assignable; `undefined` would reject it.
  teardown(): void | EnvironmentTeardownReport | Promise<void | EnvironmentTeardownReport>
}

/**
 * A test environment such as node or jsdom. Runs in the worker.
 * @public
 */
export interface Environment<
  Name extends string = string,
  Options = Record<string, never>,
  G extends object = typeof globalThis,
> {
  readonly name: Name
  /** The realms it supports. One that lists only `context` forces the `realm` tier. */
  readonly realms: readonly EnvironmentRealm[]
  /** Export conditions it implies. */
  readonly conditions?: readonly string[]
  /** Runs once per worker (import jsdom, …); the result goes to every `setup`. */
  prepare?(options: Options): unknown
  setup(
    context: EnvironmentSetupContext<Options>,
    prepared: unknown,
  ): EnvironmentInstance<G> | Promise<EnvironmentInstance<G>>
}

/**
 * Where a worker finds its `Environment`: the module and the export that holds it, plus the
 * options its `setup` receives. A ref to a *value*, not a function, so it can't be a `ModuleRef`;
 * it has the same `{ module, export }` shape, and crosses threads as data.
 * @public
 */
export interface EnvironmentRef {
  /**
   * Where the worker imports the environment from: an absolute path, or an absolute URL (a `file:`
   * URL, usually from `import.meta.resolve`). Not a bare package specifier: the worker would resolve
   * that from its own location, not the project's, so the coordinator resolves it first and the
   * worker rejects it (`ORCH_BAD_CONFIG`).
   */
  readonly module: string
  readonly export: string
  /** What `setup` and `prepare` get as `options`. */
  readonly options: { readonly [key: string]: JsonValue }
}

/**
 * What a worker asks a dialect to resolve when a file's docblock names an environment
 * (`@jest-environment jsdom`, `@jest-environment-options {...}`).
 * @public
 */
export interface EnvironmentPragmaRequest {
  /** The pragma's value as written: a name, a package or a path. */
  readonly name: string
  /** The options pragma, parsed (`null` when the file gives none). */
  readonly options: JsonValue
  readonly rootDir: string
  readonly testPath: string
  /** The project's own environment, whose options (`testEnvironmentOptions`, `globals`) the file's build on. */
  readonly base: EnvironmentRef
}

/**
 * A dialect's way to turn a file's environment pragma into an `EnvironmentRef` (its `module` an
 * absolute path or URL). Loaded in the worker by `ModuleRef`; it may throw the dialect's own error
 * for a name that doesn't resolve.
 * @public
 */
export type EnvironmentResolver = (
  request: EnvironmentPragmaRequest,
) => EnvironmentRef | Promise<EnvironmentRef>

/**
 * The signature of `defineEnvironment`: it keeps the literal name.
 * @public
 */
export type DefineEnvironment = <
  const Name extends string,
  Options = Record<string, never>,
  G extends object = typeof globalThis,
>(
  environment: Environment<Name, Options, G>,
) => Environment<Name, Options, G>

/**
 * The options each built-in environment takes.
 * @public
 */
export interface EnvironmentOptionsMap {
  readonly node: Record<string, never>
  readonly jsdom: {
    readonly html?: string
    readonly url?: string
    readonly userAgent?: string
    readonly pretendToBeVisual?: boolean
    /** The export conditions the resolver uses for this project's imports (replaces `browser`). */
    readonly customExportConditions?: readonly string[]
    readonly jsdom?: Readonly<Record<string, unknown>>
  }
  readonly 'happy-dom': {
    readonly url?: string
    readonly width?: number
    readonly height?: number
    readonly settings?: Readonly<Record<string, unknown>>
  }
}

/**
 * A built-in environment's name.
 * @public
 */
export type BuiltinEnvironmentName = keyof EnvironmentOptionsMap

/**
 * An environment in config: a built-in name, a built-in with checked options, or a custom one
 * (a package or path) with free-form options.
 * @public
 */
export type EnvironmentConfig<Name extends string = string> =
  | BuiltinEnvironmentName
  | {
      [N in BuiltinEnvironmentName]: {
        readonly name: N
        readonly options?: EnvironmentOptionsMap[N]
      }
    }[BuiltinEnvironmentName]
  | {
      readonly name: Name extends BuiltinEnvironmentName ? never : Name
      readonly options?: Readonly<Record<string, unknown>>
    }

/**
 * The signature of the `environment()` config helper: a literal built-in name gets its options
 * checked (a plain union with a `{ name: string }` arm would accept `jsdom` with `width`).
 * @public
 */
export type EnvironmentHelper = <const N extends string>(
  config: N extends BuiltinEnvironmentName
    ? { readonly name: N; readonly options?: EnvironmentOptionsMap[N] }
    : { readonly name: N; readonly options?: Readonly<Record<string, unknown>> },
) => EnvironmentConfig<N>
