// The public types of lazy variables (Track 6, "Types and public API"). They pass TS 7.0.2 and
// 5.9.3 under `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; the type tests
// in `test/lazy.test-d.ts` and the compile checks in `test/type-errors.test.ts` hold them there.
import type { Scope, SourceLocation, TaskInfo } from '@provino/types'

export type { Scope, TaskInfo }

/**
 * The methods every lazy handle carries, so none of them can be a key.
 * @public
 */
export type HandleMethodKey = 'let' | 'eager' | 'override' | 'from'

/**
 * Keys the runtime or a library probes on any object: `then` would make the handle thenable,
 * `asymmetricMatch` and `$$typeof` are read by `expect` and pretty-format.
 * @public
 */
export type ProtocolKey =
  | 'then'
  | 'toJSON'
  | 'toString'
  | 'valueOf'
  | 'toLocaleString'
  | 'constructor'
  | '__proto__'
  | 'prototype'
  | 'hasOwnProperty'
  | 'isPrototypeOf'
  | 'propertyIsEnumerable'
  | 'asymmetricMatch'
  | '$$typeof'
  | 'nodeType'
  | '_isMockFunction'

/**
 * A key a lazy value can't use.
 * @public
 */
export type ReservedKey = HandleMethodKey | ProtocolKey

/**
 * The key itself, or a message naming it when it is reserved (the compiler prints the message).
 * @public
 */
export type CheckKey<K extends string> = K extends ReservedKey
  ? `Error: '${K}' is reserved and cannot be a lazy key`
  : K

/**
 * A flattened, read-only view of `T`: what `$.key` reads give.
 * @public
 */
export type Values<T> = { readonly [K in keyof T]: T[K] }

/**
 * `T` with `K: V`. A key that `T` has already is replaced (through `Omit`), so a re-declare
 * leaves one property; a new key is a flat intersection, which keeps chains of 60 cheap.
 * @public
 */
export type AddKey<T, K extends string, V> = K extends keyof T
  ? Omit<T, K> & { [P in K]: V }
  : T & { [P in K]: V }

/**
 * What a definition sees besides its dependencies.
 * @public
 */
export interface DefineContext<S extends Scope = 'test'> {
  /** Runs last-in first-out at the end of the value's scope, even when the test fails. */
  onCleanup(fn: () => unknown): void
  /** Aborted on timeout, bail and Ctrl-C. */
  readonly signal: AbortSignal
  readonly key: string
  readonly scope: S
  readonly task: S extends 'test' ? TaskInfo : undefined
}

/**
 * A definition's context in `override`, with the value it replaces.
 * @public
 */
export interface OverrideContext<P, S extends Scope> extends DefineContext<S> {
  /** The value the nearest outer definition gives (a Promise for an eager key). */
  parent(): P
}

/**
 * Options of `let` and `eager`.
 * @public
 */
export interface LetOptions<S extends Scope> {
  readonly scope?: S
  /** Milliseconds before the definition is aborted with `LAZY_TIMEOUT`. */
  readonly timeout?: number
}

/**
 * What `$.from(ctx)` takes: the context object a test or hook receives.
 * @public
 */
export interface TestContextLike {
  readonly task: object
}

type DepsFor<T, L extends string, W extends string, S extends Scope> = S extends 'test'
  ? Values<T>
  : S extends 'file'
    ? Values<Pick<T, L & keyof T>>
    : Values<Pick<T, W & keyof T>>
type Narrowing<T, K> = K extends keyof T ? T[K] : unknown
type NextL<L extends string, K extends string, S extends Scope> = S extends 'test'
  ? Exclude<L, K>
  : L | K
type NextW<W extends string, K extends string, S extends Scope> = S extends 'worker'
  ? W | K
  : Exclude<W, K>
type ScopeOf<L extends string, W extends string, K> = K extends W
  ? 'worker'
  : K extends L
    ? 'file'
    : 'test'

/**
 * The chained methods of a handle. `T` is the keys so far, `L` and `W` the file- and
 * worker-scoped ones, `E` the eager ones.
 * @public
 */
export interface LazyApi<T, L extends string, W extends string, E extends string> {
  /**
   * Defines `key`. Redefining a key may only narrow its type.
   */
  let<K extends string, V extends Narrowing<T, K>, S extends Scope = 'test'>(
    key: CheckKey<K>,
    define: (deps: DepsFor<T, L, W, S>, ctx: DefineContext<S>) => V,
    options?: LetOptions<S>,
  ): Lazy<AddKey<T, K, V>, NextL<L, K, S>, NextW<W, K, S>, Exclude<E, K>>

  /**
   * Defines `key` and evaluates it in a `beforeEach` (`beforeAll` for a longer scope) at this
   * position. The value type is awaited.
   */
  eager<
    K extends string,
    V extends Narrowing<T, K> | PromiseLike<Narrowing<T, K>>,
    S extends Scope = 'test',
  >(
    key: CheckKey<K>,
    define: (deps: DepsFor<T, L, W, S>, ctx: DefineContext<S>) => V,
    options?: LetOptions<S>,
  ): Lazy<AddKey<T, K, Awaited<V>>, NextL<L, K, S>, NextW<W, K, S>, E | K>

  /**
   * Replaces `key` for the suite being collected and its descendants, and returns the handle.
   */
  override<K extends keyof T & string>(
    key: K,
    define: (
      deps: Values<T>,
      ctx: OverrideContext<K extends E ? Promise<T[K]> : T[K], ScopeOf<L, W, K>>,
    ) => K extends E ? T[K] | Promise<T[K]> : T[K],
  ): Lazy<T, L, W, E>

  /** The handle's values for the test a context object belongs to, with no async context. */
  from(ctx: TestContextLike): Values<T>
}

/**
 * A lazy handle: one read-only getter per key, plus the chained methods.
 * @public
 */
export type Lazy<
  T,
  L extends string = never,
  W extends string = never,
  E extends string = never,
> = Values<T> & LazyApi<T, L, W, E>

// biome-ignore lint/complexity/noBannedTypes: `{}` is the identity of the key intersection (no key yet); `object` or `Record<never, never>` would change what `Values` and `AddKey` give
type Empty = {}

/**
 * The handle with no keys: where every chain starts.
 * @public
 */
export type LazyRoot = Lazy<Empty>

/**
 * What a shared group needs from its caller: the keys, plus `let` and `eager` for the keys the
 * group adds.
 * @public
 */
export type SharedLazy<R> = Values<R> & Pick<LazyApi<R, never, never, never>, 'let' | 'eager'>

/**
 * A group of tests that run against any caller whose `$` has the keys `R` (and takes the extra
 * arguments `A`).
 * @public
 */
export interface SharedExamples<R, A extends unknown[] = []> {
  readonly name: string
  readonly __requires?: (r: R, ...a: A) => void
}

/**
 * Keys a context adds to its caller: it needs `R` and gives `A`.
 * @public
 */
export interface SharedContext<R, A> {
  readonly name: string
  readonly __context?: (r: R) => A
}

/**
 * What a shared context's body may add, without the keys it needs or the handle's methods.
 * @public
 */
export type ContextOutput<R, Out> = Omit<Out, keyof R | keyof LazyApi<Empty, never, never, never>>

/**
 * A test's evaluated lazy value, as the failure report lists it. B24e moves this to
 * `@provino/types` as `LazyEvaluation`.
 * @beta
 */
export interface EvaluatedLazy {
  readonly key: string
  readonly site: SourceLocation
  readonly override: boolean
  readonly ms: number
}
