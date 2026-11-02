import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnyFunction, Behaviour, ModuleRef } from '@provino/types'
import { PolicyError } from './errors.ts'

/**
 * Imports a module by specifier and returns its namespace.
 * @public
 */
export type ModuleImporter = (specifier: string) => Promise<Readonly<Record<string, unknown>>>

/**
 * Loads behaviour keys. A worker owns one loader (in its worker context), so each `ModuleRef`'s
 * module is imported once per worker however often it is called.
 * @public
 */
export interface BehaviourLoader {
  /** Returns the function a behaviour key holds, importing its module the first time. */
  load<Fn extends AnyFunction>(behaviour: Behaviour<Fn>): Promise<Fn>
}

/**
 * Options for `createBehaviourLoader`.
 * @public
 */
export interface BehaviourLoaderOptions {
  /**
   * How modules are imported. Default: `import()`, with absolute paths turned into `file:` URLs.
   * Bare specifiers then resolve from `@provino/policy`, so pass absolute refs for user modules.
   */
  readonly importModule?: ModuleImporter
}

const defaultImporter: ModuleImporter = (specifier) =>
  import(isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier)

/**
 * Creates a behaviour loader with its own module cache.
 * @public
 */
export function createBehaviourLoader(options: BehaviourLoaderOptions = {}): BehaviourLoader {
  const importModule = options.importModule ?? defaultImporter
  const modules = new Map<string, Promise<Readonly<Record<string, unknown>>>>()

  function importOnce(specifier: string): Promise<Readonly<Record<string, unknown>>> {
    let pending = modules.get(specifier)
    if (pending === undefined) {
      pending = importModule(specifier)
      // A failed import is not cached, so a later call can try again.
      pending.catch(() => modules.delete(specifier))
      modules.set(specifier, pending)
    }
    return pending
  }

  async function loadRef<Fn extends AnyFunction>(ref: ModuleRef<Fn>): Promise<Fn> {
    let namespace: Readonly<Record<string, unknown>>
    try {
      namespace = await importOnce(ref.module)
    } catch (cause) {
      throw new PolicyError('POLICY_BEHAVIOUR_LOAD_FAILED', `can't import "${ref.module}"`, {
        cause,
      })
    }
    const fn = namespace[ref.export]
    if (typeof fn !== 'function') {
      throw new PolicyError(
        'POLICY_BEHAVIOUR_NOT_FUNCTION',
        `"${ref.module}" has no function export "${ref.export}"`,
      )
    }
    // The ref's type says what the export is; it was checked to be a function above.
    return fn as Fn
  }

  return {
    load<Fn extends AnyFunction>(behaviour: Behaviour<Fn>): Promise<Fn> {
      return typeof behaviour === 'function' ? Promise.resolve(behaviour) : loadRef(behaviour)
    },
  }
}

/**
 * Calls a behaviour key with `args`: a closure directly, a `ModuleRef` after `loader` has
 * imported it (once per loader).
 * @public
 */
export async function callBehaviour<Args extends readonly unknown[], Result>(
  loader: BehaviourLoader,
  behaviour: Behaviour<(...args: Args) => Result>,
  ...args: Args
): Promise<Awaited<Result>> {
  const fn = await loader.load(behaviour)
  return await fn(...args)
}
