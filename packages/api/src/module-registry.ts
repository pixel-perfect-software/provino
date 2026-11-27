// The native API's module-registry members (B28): `resetModules`, `isolateModules` and
// `isolateModulesAsync`, over the file registry running now (`host.registry()`, read when one is
// called), so each acts on the file that calls it. Provino's own design, no policy keys: each
// returns the callback's value (there is no `jest` object to chain), and a nested isolation is the
// module-mock registry's own `MockError` `nested-isolation`.
import { ProvinoApiError } from './errors.ts'
import type { ApiHost, ProvinoApi } from './types.ts'

/**
 * The names of `ProvinoApi` that act on the module registry. Plain members: in the slot, the
 * served module and the globals alike, so nothing filters on them and no runtime list is kept.
 * @internal
 */
export type ProvinoModuleRegistryName = 'resetModules' | 'isolateModules' | 'isolateModulesAsync'

function assertCallback(fn: unknown, member: ProvinoModuleRegistryName): void {
  if (typeof fn === 'function') return
  throw new ProvinoApiError(
    'API_ISOLATE_CALLBACK',
    `${member}() takes a function to run with a fresh module registry, but received ${fn === null ? 'null' : typeof fn}.`,
  )
}

/**
 * `resetModules`, `isolateModules` and `isolateModulesAsync` over the file registry running now.
 * Under isolation `none` the registry is the worker's, so `resetModules` forgets the instances
 * every later file of the worker would have shared.
 * @internal
 */
export function moduleRegistryOver(host: ApiHost): Pick<ProvinoApi, ProvinoModuleRegistryName> {
  return {
    resetModules: (): void => {
      host.registry().resetModules()
    },
    isolateModules: <R>(fn: () => R): R => {
      assertCallback(fn, 'isolateModules')
      return host.registry().isolateModules(fn)
    },
    isolateModulesAsync: async <R>(fn: () => Promise<R>): Promise<R> => {
      assertCallback(fn, 'isolateModulesAsync')
      return await host.registry().isolateModulesAsync(fn)
    },
  }
}
