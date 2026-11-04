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
 * What an environment's `setup` receives.
 * @public
 */
export interface EnvironmentSetupContext<Options> {
  readonly options: Options
  readonly realm: EnvironmentRealm
  readonly scope: EnvironmentScope
  readonly testPath: string
  /** The file's docblock pragmas. */
  readonly pragmas: Readonly<Record<string, string | readonly string[]>>
  readonly console: Console
  /** Aborted when the worker cancels. */
  readonly signal: AbortSignal
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
  teardown(): void | Promise<void>
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
  /** An absolute path, a `file:` URL, or a package specifier the worker can import. */
  readonly module: string
  readonly export: string
  /** What `setup` and `prepare` get as `options`. */
  readonly options: { readonly [key: string]: JsonValue }
}

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
