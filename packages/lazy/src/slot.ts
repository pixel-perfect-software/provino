// The slot the worker puts the lazy runtime in. The public functions read it when they are called,
// so a test file's own copy of `@provino/lazy` and the umbrella's reach the same runtime (D83's
// pattern: a `Symbol.for` key on `globalThis`, not a global name).
import type { LazyEvaluation, TestRunHandle } from '@provino/types'
import type {
  ContextOutput,
  Lazy,
  LazyRoot,
  SharedContext,
  SharedExamples,
  SharedLazy,
  Values,
} from './types.ts'

/**
 * The key the runtime sits under on `globalThis`.
 * @public
 */
export const LAZY_RUNTIME_SLOT: unique symbol = Symbol.for('provino.lazy.runtime')

/**
 * What the worker installs: the implementation behind every public entry point.
 * @public
 */
export interface LazyRuntime {
  readonly lazy: LazyRoot
  sharedExamples<R, A extends unknown[] = []>(
    name: string,
    body: ($: SharedLazy<R>, ...args: A) => void,
  ): SharedExamples<R, A>
  itBehavesLike<R, A extends unknown[]>(
    group: SharedExamples<R, A>,
    $: NoInfer<Values<R>>,
    ...args: NoInfer<A>
  ): void
  includeExamples<R, A extends unknown[]>(
    group: SharedExamples<R, A>,
    $: NoInfer<Values<R>>,
    ...args: NoInfer<A>
  ): void
  sharedContext<R, Out>(
    name: string,
    body: ($: SharedLazy<R>) => Values<Out>,
  ): SharedContext<R, ContextOutput<R, Out>>
  includeContext<T extends R, L extends string, W extends string, E extends string, R, A>(
    $: Lazy<T, L, W, E>,
    context: SharedContext<R, A>,
  ): Lazy<Omit<T, keyof A> & A, L, W, E>
  evaluatedLazies(run: TestRunHandle): readonly LazyEvaluation[]
}

type SlotHolder = { [LAZY_RUNTIME_SLOT]?: LazyRuntime }

/**
 * The installed runtime, or `undefined` when none is.
 * @public
 */
export function currentLazyRuntime(): LazyRuntime | undefined {
  return (globalThis as SlotHolder)[LAZY_RUNTIME_SLOT]
}

/**
 * Puts `runtime` in the slot (non-enumerable, configurable) and returns the function that takes
 * it out again, but only if it is still the one there.
 * @public
 */
export function installLazyRuntime(runtime: LazyRuntime): () => void {
  Object.defineProperty(globalThis, LAZY_RUNTIME_SLOT, {
    value: runtime,
    configurable: true,
    enumerable: false,
    writable: true,
  })
  return () => {
    if (currentLazyRuntime() === runtime) {
      Reflect.deleteProperty(globalThis, LAZY_RUNTIME_SLOT)
    }
  }
}
