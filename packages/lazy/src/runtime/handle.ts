// The handle: a frozen object with one getter per key and the chained methods. It carries key names
// only, never a suite: a read resolves from the running test's innermost suite.
import { inspect } from 'node:util'
import type { Scope } from '@provino/types'
import { LazyError } from '../errors.ts'
import type { Lazy, LetOptions, TestContextLike } from '../types.ts'
import { eagerHook } from './eager.ts'
import { peek, readFrom, viewOf } from './read.ts'
import type { DefineFn, Engine, LazyEntry } from './state.ts'
import { inheritedEagerScope, register } from './table.ts'

/** A handle as the runtime builds it; the public types are applied at the boundary. */
export type AnyLazy = Lazy<Record<string, unknown>, string, string, string>

/**
 * A forwarder that called a registration method for the user (the public `lazy` root): the site is
 * the caller of this function, not the forwarder's own line.
 */
type Via = ((...args: never[]) => unknown) | undefined

const NOT_EVALUATED = Object.freeze({ [inspect.custom]: () => '<lazy>' })

/** Builds handles for one engine. */
export function createHandles(engine: Engine): (keys: readonly string[]) => AnyLazy {
  const descriptors = new Map<string, PropertyDescriptor>()

  function descriptorFor(key: string): PropertyDescriptor {
    let found = descriptors.get(key)
    if (found === undefined) {
      found = {
        enumerable: true,
        get(): unknown {
          const frame = engine.host.current()
          if (frame === undefined) {
            throw new LazyError(
              'LAZY_NO_TEST',
              `\`${key}\` can only be read in a test or a beforeAll/afterAll hook, and no test is running here. Use $.from(ctx) to read it with a test's context.`,
            )
          }
          return readFrom(engine, frame, frame.suite, key, null)
        },
        set(): void {
          throw new LazyError(
            'LAZY_READONLY',
            `\`${key}\` is read-only: a lazy value cannot be assigned. Override it with $.override('${key}', …) in a describe.`,
          )
        },
      }
      descriptors.set(key, found)
    }
    return found
  }

  function makeHandle(keys: readonly string[]): AnyLazy {
    const handle = {}
    for (const key of keys) Object.defineProperty(handle, key, descriptorFor(key))

    function define(
      kind: 'let' | 'eager',
      api: (...args: never[]) => unknown,
      key: string,
      fn: DefineFn,
      options: LetOptions<Scope> | undefined,
      via: Via,
    ): AnyLazy {
      const entry: LazyEntry = register(engine, kind, key, fn, options, via ?? api)
      if (kind === 'eager') {
        engine.host.addHook(
          entry.suite,
          entry.declared === 'test' ? 'beforeEach' : 'beforeAll',
          eagerHook(engine, entry),
        )
      }
      return makeHandle(keys.includes(key) ? keys : [...keys, key])
    }

    const methods = {
      let: function letMethod(
        key: string,
        fn: DefineFn,
        options?: LetOptions<Scope>,
        via?: Via,
      ): AnyLazy {
        return define('let', letMethod, key, fn, options, via)
      },
      eager: function eagerMethod(
        key: string,
        fn: DefineFn,
        options?: LetOptions<Scope>,
        via?: Via,
      ): AnyLazy {
        return define('eager', eagerMethod, key, fn, options, via)
      },
      override: function overrideMethod(key: string, fn: DefineFn, via?: Via): unknown {
        const entry = register(engine, 'override', key, fn, undefined, via ?? overrideMethod)
        // An override of a file or worker eager value is evaluated where it is declared: the
        // outer hook resolves from the outer suite and never sees it.
        const scope = inheritedEagerScope(entry)
        if (scope !== undefined && scope !== 'test') {
          engine.host.addHook(entry.suite, 'beforeAll', eagerHook(engine, entry))
        }
        return handle
      },
      from(ctx: TestContextLike): object {
        const run = engine.host.runOf(ctx)
        if (run === undefined) {
          throw new LazyError(
            'LAZY_BAD_CONTEXT',
            '$.from(ctx) needs the context object a test or hook receives, and this is not one.',
          )
        }
        const suite = run.test.suite
        return viewOf(engine, { kind: 'test', run, suite, file: suite.file })
      },
    }
    for (const [name, fn] of Object.entries(methods)) {
      Object.defineProperty(handle, name, { value: fn, enumerable: false })
    }
    Object.defineProperties(handle, {
      toJSON: { value: () => ({ lazy: [...keys] }) },
      [Symbol.toStringTag]: { value: 'Lazy' },
      [inspect.custom]: {
        value: (depth: number, options: object): string => {
          const frame = engine.host.current()
          const shown: Record<string, unknown> = {}
          for (const key of keys) {
            const seen = frame === undefined ? undefined : peek(engine, frame, key)
            shown[key] = seen?.evaluated === true ? seen.value : NOT_EVALUATED
          }
          return `Lazy ${inspect(shown, { ...options, depth: depth })}`
        },
      },
    })
    return Object.freeze(handle) as AnyLazy
  }

  return makeHandle
}
