// @provino/api: the native runtime (D185, D186). The worker loads these factories by the refs
// `provino` hands `@provino/config` (`NativeRuntimeRefs`), for a project with no dialect.
export { ApiError, type ApiErrorCode } from './errors.ts'
export { PROVINO_API_SLOT, provinoGlobals, provinoModuleScope } from './scope.ts'
export type {
  ApiHost,
  ProvinoApi,
  ProvinoMocks,
  ProvinoSpyOn,
  ProvinoTimers,
} from './types.ts'
