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
      // Drop a failed import from this cache. Node caches a module whose evaluation threw, so a
      // retry rethrows; dropping it still lets a custom importer (or a missing file) retry.
      pending.catch(() => modules.delete(specifier))
      modules.set(specifier, pending)
    }
    return pending
  }

  async function loadRef<Fn extends AnyFunction>(ref: ModuleRef<Fn>): Promise<Fn> {
    if (ref.module.startsWith('./') || ref.module.startsWith('../')) {
      // A relative specifier would resolve against this file, not the dialect that wrote it.
      throw new PolicyError(
        'POLICY_BEHAVIOUR_LOAD_FAILED',
        `"${ref.module}" is relative; build refs with import.meta.resolve()`,
      )
    }
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
      if (typeof behaviour === 'function') return Promise.resolve(behaviour)
      // A nullable behaviour key (`orderHooks`, …) must be checked before it is loaded.
      if (behaviour === null || typeof behaviour !== 'object') {
        return Promise.reject(
          new PolicyError('POLICY_BEHAVIOUR_NOT_FUNCTION', `not a behaviour: ${String(behaviour)}`),
        )
      }
      return loadRef(behaviour)
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
