// @provino/api: the native runtime (D185, D186). The worker loads these factories by the refs
// `provino` hands `@provino/config` (`NativeRuntimeRefs`), for a project with no dialect.

export { ProvinoApiError, type ProvinoApiErrorCode } from './errors.ts'
export { PROVINO_MODULE_MOCK_NAMES, type ProvinoModuleMockName } from './module-mocks.ts'
export {
  PROVINO_API_SLOT,
  PROVINO_SERVED_MODULE,
  type ProvinoModuleScope,
  provinoGlobals,
  provinoModuleScope,
  uninstallProvinoApi,
} from './scope.ts'
export type {
  ApiHost,
  ProvinoApi,
  ProvinoGlobalsApi,
  ProvinoMock,
  ProvinoMockFactory,
  ProvinoMocks,
  ProvinoSpyOn,
  ProvinoTimers,
} from './types.ts'
