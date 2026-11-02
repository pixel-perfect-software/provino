import type * as types from '@provino/types'
import { expectTypeOf } from 'expect-type'

// Types only: the package has no value exports.
expectTypeOf<keyof typeof types>().toEqualTypeOf<never>()

// A wrong assertion must be a type error, or the type tests prove nothing.
// @ts-expect-error string is not number
expectTypeOf<string>().toEqualTypeOf<number>()
