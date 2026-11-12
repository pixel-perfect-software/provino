// Track 3 §Types → Resolver API: the one resolver contract. `@provino/resolver` (B05)
// implements it (`createResolver`, typed by `CreateResolver`), the loader consumes it, and a
// plugin may contribute one. The ready-made mappers stay in `@provino/resolver`.
import type { JsonValue } from './clone-safe.ts'
import type { ModuleRef } from './policy/behaviour.ts'

/**
 * What kind of reference is being resolved. `import-meta-resolve` is `import.meta.resolve`
 * (Track 2). A mock call's specifier resolves as the kind `ModulePolicy.mockResolveKind` names.
 * @public
 */
export type ResolveKind = 'import' | 'require' | 'dynamic-import' | 'import-meta-resolve'

/**
 * Where a specifier is resolved from.
 * @public
 */
export interface ResolveContext {
  /** The importing file, absolute. */
  readonly importer: string
  readonly kind: ResolveKind
  /** Environment conditions (Track 8); the kind's own condition is appended by the resolver. */
  readonly conditions: readonly string[]
}

/**
 * A resolution: a file, a Node builtin, a virtual module, or a miss with what was tried.
 * @public
 */
export type ResolveResult =
  | {
      readonly type: 'file'
      readonly path: string
      readonly format: 'esm' | 'cjs' | 'json' | 'wasm' | 'addon' | 'unknown'
      readonly packageJson: string | null
      readonly mappedBy: string | null
    }
  | { readonly type: 'builtin'; readonly id: `node:${string}` }
  | { readonly type: 'virtual'; readonly id: string; readonly owner: 'vite-host' }
  | {
      readonly type: 'not-found'
      readonly specifier: string
      readonly importer: string
      readonly tried: readonly string[]
      readonly mappedBy: string | null
      /** The mapping rule's targets as configured (`$1` not yet replaced), when a rule matched. */
      readonly declared?: readonly string[]
    }

/**
 * A mapper's match: candidates to try in order (Jest array targets).
 * @public
 */
export interface MapperHit {
  readonly candidates: readonly string[]
  /** What happens when no candidate resolves. Jest's `moduleNameMapper` is `error`. */
  readonly onMiss: 'error' | 'continue'
  /** Shown in errors: the regex or alias key. */
  readonly rule: string
  /** The rule's targets as configured, before `$n` is replaced (Jest prints them in its miss error). */
  readonly declared?: readonly string[]
}

/**
 * One mapping rule set from a dialect adapter (Track 11). Mappers run in order; the first hit
 * wins.
 * @public
 */
export interface ModuleMapper {
  readonly id: string
  map(specifier: string, context: ResolveContext): MapperHit | null
}

/**
 * Builds a `ModuleMapper` from the options its config carried. A worker loads it by `ModuleRef`
 * (`SerializedModuleMapper`), because a mapper has methods and can't cross a thread.
 * @public
 */
export type ModuleMapperFactory = (options: JsonValue) => ModuleMapper

/**
 * A mapper as it crosses coordinator → worker: the factory's ref and the data it is called with.
 * @public
 */
export interface SerializedModuleMapper {
  readonly factory: ModuleRef<ModuleMapperFactory>
  readonly options: JsonValue
}

/**
 * A module resolver. Sync, because the native engine's resolve hook is.
 * @public
 */
export interface Resolver {
  resolve(specifier: string, context: ResolveContext): ResolveResult
  /** Drops file-system caches; called when watch mode sees files added or removed. */
  invalidate(paths?: readonly string[]): void
  readonly fingerprint: string
}

/**
 * The options Jest passes to a custom resolver (the part Provino supplies). Track 11 owns the
 * exact shape.
 * @beta
 */
export interface JestResolverOptions {
  readonly basedir: string
  readonly conditions?: readonly string[]
  readonly defaultResolver: (path: string, options: JestResolverOptions) => string
  readonly extensions?: readonly string[]
  readonly moduleDirectory?: readonly string[]
  readonly paths?: readonly string[]
  readonly rootDir?: string
}

/**
 * A Jest `resolver` module: a function, or an object with `sync` and/or `async`.
 * @beta
 */
export type JestCustomResolver =
  | ((path: string, options: JestResolverOptions) => string)
  | {
      readonly sync?: (path: string, options: JestResolverOptions) => string
      readonly async?: (path: string, options: JestResolverOptions) => Promise<string>
    }

/**
 * Options for `createResolver`.
 * @public
 */
export interface ResolverOptions {
  readonly root: string
  readonly mappers: readonly ModuleMapper[]
  readonly extensions: readonly string[]
  readonly extensionAlias?: Readonly<Record<string, readonly string[]>>
  readonly mainFields?: readonly string[]
  /** Jest `moduleDirectories`. */
  readonly moduleDirectories?: readonly string[]
  /** Jest `modulePaths`: retried after a miss. */
  readonly modulePaths?: readonly string[]
  readonly roots?: readonly string[]
  readonly tsconfig?: 'auto' | false | { readonly configFile: string; readonly references?: 'auto' }
  readonly browserField?: boolean
  readonly symlinks?: boolean
  /** Jest's `resolver` module, called with Jest's exact shape. */
  readonly custom?: JestCustomResolver
}

/**
 * The signature of `createResolver` in `@provino/resolver`.
 * @public
 */
export type CreateResolver = (options: ResolverOptions) => Resolver
