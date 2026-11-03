// Track 3 §Types → Resolver API: the one resolver contract. `@provino/resolver` (B05)
// implements it, the loader consumes it, and a plugin may contribute one. Options, the factory
// and the ready-made mappers stay in `@provino/resolver`.

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
