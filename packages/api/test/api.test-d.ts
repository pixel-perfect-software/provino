// The public API of @provino/api: the factories, the API they build, and misuse.
import {
  type ApiHost,
  PROVINO_API_SLOT,
  type ProvinoApi,
  ProvinoApiError,
  type ProvinoApiErrorCode,
  type ProvinoGlobalsApi,
  type ProvinoModuleScope,
  type ProvinoTimers,
  provinoGlobals,
  provinoModuleScope,
  uninstallProvinoApi,
} from '@provino/api'
import type { FixtureTestApi, SuiteApi } from '@provino/core'
import type { Mock, SpiedMethod } from '@provino/mock'
import type { GlobalsFactory, ModuleScopeFactory } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The factories are what `NativeRuntimeRefs` names.
expectTypeOf(provinoModuleScope).toExtend<ModuleScopeFactory>()
expectTypeOf(provinoGlobals).toExtend<GlobalsFactory>()
expectTypeOf(PROVINO_API_SLOT).toEqualTypeOf<typeof PROVINO_API_SLOT>()

declare const host: ApiHost
expectTypeOf(provinoModuleScope(host)).toEqualTypeOf<ProvinoModuleScope>()
// The worker disposes it as it stops.
expectTypeOf(provinoModuleScope(host)).toExtend<Disposable>()
expectTypeOf(provinoModuleScope(host)('/a.test.ts')).toEqualTypeOf<
  Readonly<Record<string, unknown>>
>()
expectTypeOf(uninstallProvinoApi).toEqualTypeOf<(api: ProvinoApi) => boolean>()
// @ts-expect-error it takes the API it installed
uninstallProvinoApi()
expectTypeOf(provinoGlobals(host)).toEqualTypeOf<ProvinoGlobalsApi>()
// The module-mock names are served per module, never globals.
expectTypeOf<ProvinoGlobalsApi>().not.toHaveProperty('mock')
expectTypeOf<ProvinoApi>().toHaveProperty('mock')
expectTypeOf(new ProvinoApiError('API_MOCK_FACTORY', 'm').code).toEqualTypeOf<ProvinoApiErrorCode>()
// @ts-expect-error the code is one of ProvinoApiErrorCode
new ProvinoApiError('API_OTHER', 'm')
// @ts-expect-error the factories take the worker's host
provinoModuleScope()
// @ts-expect-error a factory takes the host and nothing else
const extra: unknown = provinoGlobals(host, 'extra')

declare const api: ProvinoApi
expectTypeOf(api.describe).toEqualTypeOf<SuiteApi>()
expectTypeOf(api.test).toEqualTypeOf<FixtureTestApi>()

// `fn` infers its implementation's type.
const add = api.fn((a: number, b: number) => a + b)
expectTypeOf(add).toEqualTypeOf<Mock<(a: number, b: number) => number>>()
expectTypeOf(add(1, 2)).toEqualTypeOf<number>()
// @ts-expect-error the mock keeps its implementation's parameters
add('1', 2)

// `spyOn` takes only a method's key.
const target = { greet: (name: string) => `hi ${name}`, level: 1 }
expectTypeOf(api.spyOn(target, 'greet')).toEqualTypeOf<SpiedMethod<(name: string) => string>>()
// @ts-expect-error 'missing' is not a key of the target
api.spyOn(target, 'missing')
// @ts-expect-error 'level' is not a method
api.spyOn(target, 'level')

// `replaceProperty` keeps the property's type.
api.replaceProperty(target, 'level', 2)
// @ts-expect-error the new value has the property's type
api.replaceProperty(target, 'level', 'two')

// `timers` chains.
expectTypeOf(api.timers.useFakeTimers().advanceTimersByTime(10)).toEqualTypeOf<ProvinoTimers>()
expectTypeOf(api.timers.getTimerCount()).toEqualTypeOf<number>()
// @ts-expect-error advancing takes milliseconds
api.timers.advanceTimersByTime('10')

export { extra }
