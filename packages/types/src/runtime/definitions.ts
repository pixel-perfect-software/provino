// Track 5 §Types → Definition table: fixtures and lazy variables share one builder type and one
// runtime entry. `@provino/core` owns the table (T5.9); `@provino/lazy` builds on it through
// `LazyHost` and never exports anything core imports (§6 "Duplicates and cycles").
import type { SourceLocation } from './tree.ts'

/**
 * How long a fixture or lazy value lives: one test attempt, one file, or one worker.
 * @public
 */
export type Scope = 'test' | 'file' | 'worker'

/**
 * Registers cleanups that run, last first, when the value's scope ends (even on failure).
 * @public
 */
export interface CleanupRegistrar {
  onCleanup(fn: () => void | Promise<void>): void
}

/**
 * The definitions a builder has so far: each key's value type and scope.
 * @public
 */
export interface Defs {
  readonly [key: string]: { readonly value: unknown; readonly scope: Scope }
}

/**
 * The keys a factory of scope `S` may read: a `test` factory sees every key, a `file` factory
 * only `file` and `worker` keys, a `worker` factory only `worker` keys.
 * @public
 */
export type VisibleFrom<D extends Defs, S extends Scope> = {
  readonly [K in keyof D as S extends 'test'
    ? K
    : S extends 'file'
      ? D[K]['scope'] extends 'file' | 'worker'
        ? K
        : never
      : D[K]['scope'] extends 'worker'
        ? K
        : never]: D[K]['value']
}

/**
 * The builder behind `test.extend` (builder form) and `lazy.let`: each `define` adds a key, with
 * its value type inferred. Defining an existing key, reading a narrower scope, or overriding with
 * another value type is a compile error.
 * @public
 */
export interface DefinitionBuilder<D extends Defs> {
  define<K extends string, V, S extends Scope = 'test'>(
    key: K extends keyof D ? never : K,
    options: { readonly scope?: S; readonly auto?: boolean; readonly injected?: boolean },
    factory: (deps: VisibleFrom<D, S>, cleanup: CleanupRegistrar) => V | Promise<V>,
  ): DefinitionBuilder<D & { readonly [P in K]: { readonly value: Awaited<V>; readonly scope: S } }>
  override<K extends keyof D & string>(
    key: K,
    factory: (
      deps: VisibleFrom<D, D[K]['scope']>,
      ctx: CleanupRegistrar & { readonly parent: () => Promise<D[K]['value']> },
    ) => D[K]['value'] | Promise<D[K]['value']>,
  ): DefinitionBuilder<D>
}

/**
 * One runtime entry of the definition table: one per key per suite level. `parent` links an
 * override to the definition it overrides.
 *
 * Resolution rules (Track 5): values are memoized per scope instance; cleanups run in reverse
 * creation order when the scope ends; depending on a narrower scope is a `DefinitionScopeError`
 * at definition time; a cycle is a `DefinitionCycleError`; reading a `test` key with no current
 * test is a `DefinitionAccessError`. `auto` entries resolve before `beforeEach`.
 * @public
 */
export interface Definition<K extends string = string, V = unknown, D = unknown> {
  readonly key: K
  readonly kind: 'fixture' | 'lazy'
  readonly scope: Scope
  /** A fixture's `auto`, or an eager lazy value (`let!`). */
  readonly auto: boolean
  readonly injected: boolean
  /** Dependencies parsed from the factory's source (dialect fixtures), or `null` to resolve on read. */
  readonly staticDeps: readonly string[] | null
  readonly parent: Definition<K, V, D> | null
  readonly location: SourceLocation | null
  readonly factory: (
    deps: D,
    ctx: CleanupRegistrar & { readonly parent: () => Promise<V> },
  ) => V | Promise<V>
}
