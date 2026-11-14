// The worker builds the host it hands to a dialect's globals factory as `RuntimeGlobalsHost`. A
// `GlobalsFactory` is bivariant in its host, so nothing at the call site stops the worker passing
// the wrong `api` or `expect`; this is where the two meet. The bench is the one package that may
// import both the orchestrator's worker and a dialect's runtime.
import type { RuntimeApi } from '@provino/core'
import type { JestGlobalsHost, jestGlobals, jestModuleScope } from '@provino/dialect-jest/runtime'
import type { createExpect } from '@provino/expect'
import type { MockRegistry } from '@provino/mock'
import type { RuntimeGlobalsHost } from '@provino/orchestrator/worker'
import type { FakeClock } from '@provino/timers'
import type {
  FileRegistry,
  GlobalsHost,
  MockPolicy,
  ModuleMockRegistry,
  TimersPolicy,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// What the worker passes is what the Jest dialect's factory takes.
expectTypeOf<RuntimeGlobalsHost>().toExtend<Parameters<typeof jestGlobals>[0]>()
expectTypeOf<RuntimeGlobalsHost>().toExtend<JestGlobalsHost>()
expectTypeOf<RuntimeGlobalsHost>().toExtend<GlobalsHost>()

// Both sides name core's and expect's real types, not `object`.
expectTypeOf<RuntimeGlobalsHost['api']>().toEqualTypeOf<RuntimeApi>()
expectTypeOf<RuntimeGlobalsHost['expect']>().toEqualTypeOf<ReturnType<typeof createExpect>>()
expectTypeOf<JestGlobalsHost['api']>().toEqualTypeOf<RuntimeGlobalsHost['api']>()
expectTypeOf<JestGlobalsHost['expect']>().toEqualTypeOf<RuntimeGlobalsHost['expect']>()

expectTypeOf<RuntimeGlobalsHost['mocks']>().returns.toEqualTypeOf<MockRegistry>()
expectTypeOf<JestGlobalsHost['mocks']>().returns.toEqualTypeOf<MockRegistry>()
expectTypeOf<RuntimeGlobalsHost['mockPolicy']>().toEqualTypeOf<MockPolicy>()
expectTypeOf<RuntimeGlobalsHost['timers']>().returns.toEqualTypeOf<FakeClock>()
expectTypeOf<JestGlobalsHost['timers']>().returns.toEqualTypeOf<FakeClock>()
expectTypeOf<RuntimeGlobalsHost['timersPolicy']>().toEqualTypeOf<TimersPolicy>()

declare const registry: () => FileRegistry
declare const mocks: () => MockRegistry
declare const mockPolicy: MockPolicy
declare const moduleMocks: () => ModuleMockRegistry
declare const timers: () => FakeClock
declare const timersPolicy: TimersPolicy
declare const seed: number
declare const environmentTornDown: () => boolean
declare const setDefaultTimeout: (ms: number) => void
declare const setDefaultRetry: RuntimeGlobalsHost['setDefaultRetry']
declare const setDescribeRetry: RuntimeGlobalsHost['setDescribeRetry']
declare const api: RuntimeGlobalsHost['api']
declare const expectStatic: RuntimeGlobalsHost['expect']

// A host with the wrong objects is not a `RuntimeGlobalsHost`, and so not what the dialect takes.
// The parts each case keeps, so each case stays on the line its `@ts-expect-error` covers.
const core = { api, expect: expectStatic, registry }
const rest = {
  mocks,
  moduleMocks,
  mockPolicy,
  timers,
  timersPolicy,
  seed,
  environmentTornDown,
  setDefaultTimeout,
  setDefaultRetry,
  setDescribeRetry,
}
const tail = { seed, environmentTornDown, setDefaultTimeout, setDefaultRetry, setDescribeRetry }
// @ts-expect-error `api` must be core's, not any object
const wrongApi: RuntimeGlobalsHost = { ...rest, api: {}, expect: expectStatic, registry }
// @ts-expect-error `expect` must be the worker's `expect`, not any object
const wrongExpect: RuntimeGlobalsHost = { ...rest, api, expect: {}, registry }
// @ts-expect-error `registry` is part of the host
const noRegistry: RuntimeGlobalsHost = { ...rest, api, expect: expectStatic }
// @ts-expect-error `mocks` is part of the host
const noMocks: RuntimeGlobalsHost = {
  ...core,
  moduleMocks,
  mockPolicy,
  timers,
  timersPolicy,
  ...tail,
}
// @ts-expect-error `moduleMocks` is part of the host (B13c)
const noModuleMocks: RuntimeGlobalsHost = {
  ...core,
  mocks,
  mockPolicy,
  timers,
  timersPolicy,
  ...tail,
}
// @ts-expect-error `mockPolicy` is part of the host
const noMockPolicy: RuntimeGlobalsHost = {
  ...core,
  mocks,
  moduleMocks,
  timers,
  timersPolicy,
  ...tail,
}
// @ts-expect-error `timers` is part of the host (B17a)
const noTimers: RuntimeGlobalsHost = {
  ...core,
  mocks,
  moduleMocks,
  mockPolicy,
  timersPolicy,
  ...tail,
}
// @ts-expect-error `timersPolicy` is part of the host (B17a)
const noTimersPolicy: RuntimeGlobalsHost = {
  ...core,
  mocks,
  moduleMocks,
  mockPolicy,
  timers,
  ...tail,
}
// @ts-expect-error `seed` is part of the host (B17c)
const noSeed: RuntimeGlobalsHost = { ...core, ...rest, seed: undefined }
// @ts-expect-error `environmentTornDown` is part of the host (B17c)
const noTornDown: RuntimeGlobalsHost = { ...core, ...rest, environmentTornDown: undefined }
// @ts-expect-error `setDefaultTimeout` is part of the host (B17c)
const noDefaultTimeout: RuntimeGlobalsHost = { ...core, ...rest, setDefaultTimeout: undefined }
// @ts-expect-error `setDefaultRetry` is part of the host (T5.10)
const noDefaultRetry: RuntimeGlobalsHost = { ...core, ...rest, setDefaultRetry: undefined }
// @ts-expect-error `setDescribeRetry` is part of the host (T5.10)
const noDescribeRetry: RuntimeGlobalsHost = { ...core, ...rest, setDescribeRetry: undefined }
const right: RuntimeGlobalsHost = { ...core, ...rest }

// The Jest dialect's per-module bindings take the same host the worker builds.
expectTypeOf<RuntimeGlobalsHost>().toExtend<Parameters<typeof jestModuleScope>[0]>()
expectTypeOf<ReturnType<typeof jestModuleScope>>().toEqualTypeOf<
  (from: string) => Readonly<Record<string, unknown>>
>()

export {
  noDefaultRetry,
  noDefaultTimeout,
  noDescribeRetry,
  noMockPolicy,
  noMocks,
  noModuleMocks,
  noRegistry,
  noSeed,
  noTimers,
  noTimersPolicy,
  noTornDown,
  right,
  wrongApi,
  wrongExpect,
}
