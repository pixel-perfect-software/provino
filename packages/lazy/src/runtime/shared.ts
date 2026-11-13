// Shared examples and shared context (T6.7). A group is a name plus a body, kept under a
// `Symbol.for` key on the group object so a group made by one copy of this package runs under
// another's runtime. The body gets a handle with the caller's keys: a read resolves from the
// running test's innermost suite, so it sees whatever the caller's `describe` overrides.
import { LazyError } from '../errors.ts'
import type {
  ContextOutput,
  Lazy,
  SharedContext,
  SharedExamples,
  SharedLazy,
  Values,
} from '../types.ts'
import type { AnyLazy } from './handle.ts'
import { captureSite, formatSite } from './site.ts'
import type { Engine } from './state.ts'

const BODY: unique symbol = Symbol.for('provino.lazy.shared.body') as never

type Body = (...args: never[]) => unknown

/**
 * What the worker's `describe` gives lazy: open a nested suite and collect its body now.
 * @beta
 */
export type DescribeFn = (name: string, body: () => void) => void

/**
 * The shared-example and shared-context functions of one runtime.
 * @beta
 */
export interface SharedFunctions {
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
}

function bodyOf(value: unknown, api: string, made: string): Body {
  const body =
    typeof value === 'object' && value !== null ? (value as { [BODY]?: Body })[BODY] : undefined
  if (typeof body !== 'function') {
    throw new LazyError('LAZY_INVALID', `${api}(…) needs a group made by ${made}(…).`)
  }
  return body
}

function brand(name: string, body: Body, api: string): { readonly name: string } {
  if (typeof name !== 'string' || name === '' || typeof body !== 'function') {
    throw new LazyError('LAZY_INVALID', `${api}(…) needs a name and a body function.`)
  }
  const group = { name }
  Object.defineProperty(group, BODY, { value: body })
  return Object.freeze(group)
}

function keysOf($: unknown): string[] {
  return $ === null || typeof $ !== 'object' ? [] : Object.keys($)
}

/** Builds the shared functions over an engine, its handle maker and the worker's `describe`. */
export function createShared(
  engine: Engine,
  makeHandle: (keys: readonly string[]) => AnyLazy,
  describe: DescribeFn,
): SharedFunctions {
  function collecting(api: (...args: never[]) => unknown, name: string): void {
    if (engine.host.collecting() === undefined) {
      throw new LazyError(
        'LAZY_NOT_COLLECTING',
        `${name}(…) only works while a describe body, or the top of the file, is being collected. It cannot run inside a test or a hook.`,
        { site: captureSite(api) },
      )
    }
  }

  function sharedExamples(name: string, body: Body): unknown {
    return brand(name, body, 'sharedExamples')
  }

  function includeExamples(group: unknown, $: unknown, ...args: unknown[]): void {
    collecting(includeExamples, 'includeExamples')
    const body = bodyOf(group, 'includeExamples', 'sharedExamples')
    body(...([makeHandle(keysOf($)), ...args] as never[]))
  }

  function itBehavesLike(group: unknown, $: unknown, ...args: unknown[]): void {
    collecting(itBehavesLike, 'itBehavesLike')
    const body = bodyOf(group, 'itBehavesLike', 'sharedExamples')
    const name = (group as { name: string }).name
    describe(`behaves like ${name}`, () => {
      body(...([makeHandle(keysOf($)), ...args] as never[]))
    })
  }

  function sharedContext(name: string, body: Body): unknown {
    return brand(name, body, 'sharedContext')
  }

  function includeContext($: unknown, context: unknown): unknown {
    collecting(includeContext, 'includeContext')
    const body = bodyOf(context, 'includeContext', 'sharedContext')
    const keys = keysOf($)
    const out: unknown = body(...([makeHandle(keys)] as never[]))
    if (out === null || typeof out !== 'object') {
      throw new LazyError(
        'LAZY_INVALID',
        `the shared context's body must return the handle it chained its keys on (includeContext at ${formatSite(captureSite(includeContext))}).`,
      )
    }
    return makeHandle([...new Set([...keys, ...Object.keys(out)])])
  }

  return {
    sharedExamples,
    itBehavesLike,
    includeExamples,
    sharedContext,
    includeContext,
  } as unknown as SharedFunctions
}
