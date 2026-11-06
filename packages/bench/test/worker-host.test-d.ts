// The worker builds the host it hands to a dialect's globals factory as `RuntimeGlobalsHost`. A
// `GlobalsFactory` is bivariant in its host, so nothing at the call site stops the worker passing
// the wrong `api` or `expect`; this is where the two meet. The bench is the one package that may
// import both the orchestrator's worker and a dialect's runtime.
import type { RuntimeApi } from '@provino/core'
import type { JestGlobalsHost, jestGlobals } from '@provino/dialect-jest/runtime'
import type { createExpect } from '@provino/expect'
import type { MockRegistry } from '@provino/mock'
import type { RuntimeGlobalsHost } from '@provino/orchestrator/worker'
import type { FileRegistry, GlobalsHost, MockPolicy } from '@provino/types'
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

declare const registry: () => FileRegistry
declare const mocks: () => MockRegistry
declare const mockPolicy: MockPolicy
declare const api: RuntimeGlobalsHost['api']
declare const expectStatic: RuntimeGlobalsHost['expect']

// A host with the wrong objects is not a `RuntimeGlobalsHost`, and so not what the dialect takes.
// @ts-expect-error `api` must be core's, not any object
const wrongApi: RuntimeGlobalsHost = { api: {}, expect: expectStatic, registry, mocks, mockPolicy }
// @ts-expect-error `expect` must be the worker's `expect`, not any object
const wrongExpect: RuntimeGlobalsHost = { api, expect: {}, registry, mocks, mockPolicy }
// @ts-expect-error `registry` is part of the host
const noRegistry: RuntimeGlobalsHost = { api, expect: expectStatic, mocks, mockPolicy }
// @ts-expect-error `mocks` is part of the host
const noMocks: RuntimeGlobalsHost = { api, expect: expectStatic, registry, mockPolicy }
// @ts-expect-error `mockPolicy` is part of the host
const noMockPolicy: RuntimeGlobalsHost = { api, expect: expectStatic, registry, mocks }
const right: RuntimeGlobalsHost = { api, expect: expectStatic, registry, mocks, mockPolicy }

export { noMockPolicy, noMocks, noRegistry, right, wrongApi, wrongExpect }
