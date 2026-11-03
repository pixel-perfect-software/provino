// Track 3 §Types → Resolver API: the one resolver contract. `@provino/resolver` (B05)
// implements it (`createResolver`, typed by `CreateResolver`), the loader consumes it, and a
// plugin may contribute one. The ready-made mappers stay in `@provino/resolver`.

/**
 * What kind of reference is being resolved. `mock` is a mock call's specifier;
 * `import-meta-resolve` is `import.meta.resolve` (Track 2).
 * @public
 */
export type ResolveKind = 'import' | 'require' | 'dynamic-import' | 'import-meta-resolve' | 'mock'

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
