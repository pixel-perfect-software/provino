// The public entry points. Each one is a forwarder: it reads the runtime the worker installed in the
// slot when it is called, and throws `LAZY_NO_RUNTIME` when there is none. `lazy.let(...)` reads the
// slot once, so the handles it returns keep that runtime.
import type { TestRunHandle } from '@provino/types'
import { LazyError } from './errors.ts'
import { currentLazyRuntime, type LazyRuntime } from './slot.ts'
import type {
  ContextOutput,
  EvaluatedLazy,
  Lazy,
  LazyRoot,
  SharedContext,
  SharedExamples,
  SharedLazy,
  Values,
} from './types.ts'

function runtime(): LazyRuntime {
  const found = currentLazyRuntime()
  if (found === undefined) {
    throw new LazyError(
      'LAZY_NO_RUNTIME',
      'lazy values only work inside a test file Provino runs: no lazy runtime is installed here.',
    )
  }
  return found
}

/**
 * The root handle: `lazy.let('user', () => …)` starts a chain.
 * @public
 */
export const lazy: LazyRoot = Object.freeze(
  Object.defineProperties(
    {
      let(key, define, options) {
        return runtime().lazy.let(key, define, options)
      },
      eager(key, define, options) {
        return runtime().lazy.eager(key, define, options)
      },
      override(key, define) {
        return runtime().lazy.override(key, define)
      },
      from(ctx) {
        return runtime().lazy.from(ctx)
      },
    } satisfies Pick<LazyRoot, 'let' | 'eager' | 'override' | 'from'>,
    {
      toJSON: { value: () => ({ lazy: [] }) },
      [Symbol.toStringTag]: { value: 'Lazy' },
    },
  ),
)

/**
 * Defines a group of tests that any `describe` whose `$` has the keys `R` can include.
 * @public
 */
export function sharedExamples<R, A extends unknown[] = []>(
  name: string,
  body: ($: SharedLazy<R>, ...args: A) => void,
): SharedExamples<R, A> {
  return runtime().sharedExamples(name, body)
}

/**
 * Runs a shared group in a nested `describe` named `behaves like <name>`.
 * @public
 */
export function itBehavesLike<R, A extends unknown[]>(
  group: SharedExamples<R, A>,
  $: NoInfer<Values<R>>,
  ...args: NoInfer<A>
): void {
  runtime().itBehavesLike(group, $, ...args)
}

/**
 * Runs a shared group in the `describe` being collected.
 * @public
 */
export function includeExamples<R, A extends unknown[]>(
  group: SharedExamples<R, A>,
  $: NoInfer<Values<R>>,
  ...args: NoInfer<A>
): void {
  runtime().includeExamples(group, $, ...args)
}

/**
 * Defines keys that any caller whose `$` has the keys `R` can include.
 * @public
 */
export function sharedContext<R, Out>(
  name: string,
  body: ($: SharedLazy<R>) => Values<Out>,
): SharedContext<R, ContextOutput<R, Out>> {
  return runtime().sharedContext(name, body)
}

/**
 * Adds a shared context's keys to the `describe` being collected, and returns the handle with them.
 * @public
 */
export function includeContext<
  T extends R,
  L extends string,
  W extends string,
  E extends string,
  R,
  A,
>($: Lazy<T, L, W, E>, context: SharedContext<R, A>): Lazy<Omit<T, keyof A> & A, L, W, E> {
  return runtime().includeContext($, context)
}

/**
 * The lazy values a run evaluated, in order, for a reporter to print under a failure.
 * @public
 */
export function evaluatedLazies(run: TestRunHandle): readonly EvaluatedLazy[] {
  return runtime().evaluatedLazies(run)
}
