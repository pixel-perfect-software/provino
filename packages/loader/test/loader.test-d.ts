// The public API of @provino/loader.
import { createLoader, type LoaderError, type LoaderErrorCode } from '@provino/loader'
import type { CreateLoader, FileRegistry, Loader } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(createLoader).toEqualTypeOf<CreateLoader>()
expectTypeOf(createLoader).returns.toEqualTypeOf<Loader>()
expectTypeOf<ReturnType<Loader['createFileRegistry']>>().toEqualTypeOf<FileRegistry>()
expectTypeOf<LoaderError['code']>().toEqualTypeOf<LoaderErrorCode>()
expectTypeOf<'ERR_REQUIRE_ASYNC_MODULE'>().toExtend<LoaderErrorCode>()

declare const loader: Loader
// @ts-expect-error the process tier is a pool decision, never a registry tier
loader.createFileRegistry('/a.test.ts', { tier: 'process' })
declare const options: Parameters<CreateLoader>[0]
// @ts-expect-error not an engine
createLoader({ ...options, engine: 'jit' })
// @ts-expect-error exactOptionalPropertyTypes: conditions is omitted, not undefined
createLoader({ ...options, conditions: undefined })
