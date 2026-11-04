// The worker builds the host it hands to a dialect's globals factory as `RuntimeGlobalsHost`. A
// `GlobalsFactory` is bivariant in its host, so nothing at the call site stops the worker passing
// the wrong `api` or `expect`; this is where the two meet. The bench is the one package that may
// import both the orchestrator's worker and a dialect's runtime.
import type { RuntimeApi } from '@provino/core'
import type { JestGlobalsHost, jestGlobals } from '@provino/dialect-jest/runtime'
import type { createExpect } from '@provino/expect'
import type { RuntimeGlobalsHost } from '@provino/orchestrator/worker'
import type { FileRegistry, GlobalsHost } from '@provino/types'
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

declare const registry: () => FileRegistry
declare const api: RuntimeGlobalsHost['api']
declare const expectStatic: RuntimeGlobalsHost['expect']

// A host with the wrong objects is not a `RuntimeGlobalsHost`, and so not what the dialect takes.
// @ts-expect-error `api` must be core's, not any object
const wrongApi: RuntimeGlobalsHost = { api: {}, expect: expectStatic, registry }
// @ts-expect-error `expect` must be the worker's `expect`, not any object
const wrongExpect: RuntimeGlobalsHost = { api, expect: {}, registry }
// @ts-expect-error `registry` is part of the host
const noRegistry: RuntimeGlobalsHost = { api, expect: expectStatic }
const right: RuntimeGlobalsHost = { api, expect: expectStatic, registry }

export { noRegistry, right, wrongApi, wrongExpect }
