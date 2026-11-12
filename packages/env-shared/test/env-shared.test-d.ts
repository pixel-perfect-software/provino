// The public API of @provino/env-shared.
import { type Populated, type PopulateOptions, populateGlobal } from '@provino/env-shared'
import { expectTypeOf } from 'expect-type'

expectTypeOf(populateGlobal).parameter(0).toEqualTypeOf<object>()
expectTypeOf(populateGlobal).parameter(1).toEqualTypeOf<object>()
expectTypeOf(populateGlobal).returns.toEqualTypeOf<Populated>()
expectTypeOf<Populated['keys']>().toEqualTypeOf<ReadonlySet<string>>()
expectTypeOf<Populated['originals']>().toEqualTypeOf<
  ReadonlyMap<string | symbol, PropertyDescriptor>
>()
expectTypeOf<Populated['restore']>().toEqualTypeOf<() => void>()
expectTypeOf<PopulateOptions>().toEqualTypeOf<{
  readonly bindFunctions?: boolean
  readonly additionalKeys?: readonly string[]
  readonly selfReferences?: boolean
}>()

// @ts-expect-error: the window must be an object
populateGlobal(globalThis, 1)
// @ts-expect-error: options are not a list of keys
populateGlobal(globalThis, {}, ['window'])
// @ts-expect-error: the key list is readonly strings
populateGlobal(globalThis, {}, { additionalKeys: [1] })
