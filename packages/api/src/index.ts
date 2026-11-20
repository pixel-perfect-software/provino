// @provino/api: the native runtime (D185, D186). The worker loads these factories by the refs
// `provino` hands `@provino/config` (`NativeRuntimeRefs`), for a project with no dialect. Phase 2
// (B27b) builds them; until then each throws `API_NOT_BUILT`.
import type { GlobalsFactory, GlobalsHost, ModuleScopeFactory } from '@provino/types'
import { ApiError } from './errors.ts'

export { ApiError, type ApiErrorCode } from './errors.ts'

function notBuilt(name: string): never {
  throw new ApiError('API_NOT_BUILT', `${name} is not built yet (B27b)`)
}

/**
 * The served `provino` module's factory (`NativeRuntimeRefs.moduleScope`): given the worker's
 * host once, it returns the namespace each importing module gets.
 * @public
 */
export const provinoModuleScope: ModuleScopeFactory = (_host: GlobalsHost) =>
  notBuilt('provinoModuleScope')

/**
 * The native API as globals (`NativeRuntimeRefs.globals`), used under `globals: true`.
 * @public
 */
export const provinoGlobals: GlobalsFactory = (_host: GlobalsHost) => notBuilt('provinoGlobals')
