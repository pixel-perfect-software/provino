/**
 * Any function type. Behaviour keys and `ModuleRef`s are typed by one of these.
 * @public
 */
export type AnyFunction = (...args: never[]) => unknown

/**
 * A function the worker loads by module and export name, so behaviour can cross threads as data.
 *
 * `module` is an absolute path, a `file:` URL, or a package specifier that `@provino/policy` can
 * resolve (dialects build refs with `import.meta.resolve`). `__fn` is a phantom used only for
 * inference: it never exists at runtime.
 * @public
 */
export interface ModuleRef<Fn extends AnyFunction = AnyFunction> {
  readonly module: string
  readonly export: string
  readonly __fn?: Fn
}

/**
 * A behaviour policy key: a closure (same thread only) or a `ModuleRef` (crosses threads).
 * @public
 */
export type Behaviour<Fn extends AnyFunction> = Fn | ModuleRef<Fn>

/**
 * Values that resolve and merge as one unit: never recursed into, never partially overridden.
 * @public
 */
export type PolicyAtom =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | AnyFunction
  | ModuleRef
  | RegExp
  | Date
  | readonly unknown[]
  | ReadonlySet<unknown>
  | ReadonlyMap<unknown, unknown>

/**
 * A policy layer: any key may be left out, at any depth. Atoms (arrays, refs, functions, …)
 * replace the lower layer's value whole.
 * @public
 */
export type DeepPartial<T> = T extends PolicyAtom
  ? T
  : { readonly [K in keyof T]?: DeepPartial<T[K]> }

/**
 * What survives a trip to the worker: closures are dropped from the type and `ModuleRef`s kept.
 * Distributive, so `Behaviour<F>` becomes `ModuleRef<F>` (a non-distributive version keeps the
 * closure arm; Track 1 §Spikes).
 * @public
 */
export type DataOnly<T> = T extends AnyFunction
  ? never
  : T extends ModuleRef
    ? T
    : T extends PolicyAtom
      ? T
      : { readonly [K in keyof T]: DataOnly<T[K]> }
