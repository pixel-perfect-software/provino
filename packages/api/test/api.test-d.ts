// The public API of @provino/api (B27a's scaffold).
import { type ApiError, type ApiErrorCode, provinoGlobals, provinoModuleScope } from '@provino/api'
import type { GlobalsFactory, GlobalsHost, ModuleScopeFactory } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(provinoModuleScope).toEqualTypeOf<ModuleScopeFactory>()
expectTypeOf(provinoGlobals).toEqualTypeOf<GlobalsFactory>()
expectTypeOf<ApiError['code']>().toEqualTypeOf<ApiErrorCode>()
expectTypeOf<ApiErrorCode>().toEqualTypeOf<'API_NOT_BUILT'>()

declare const host: GlobalsHost
expectTypeOf(provinoModuleScope(host)).toEqualTypeOf<
  (from: string) => Readonly<Record<string, unknown>>
>()
// @ts-expect-error the factories take the worker's host
provinoModuleScope()
// @ts-expect-error a factory takes the host and nothing else
const extra: unknown = provinoGlobals(host, 'jest')
// @ts-expect-error an unknown code is not an ApiErrorCode
const code: ApiErrorCode = 'API_UNKNOWN'

export { code, extra }
