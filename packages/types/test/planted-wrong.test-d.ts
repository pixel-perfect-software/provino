import { expectTypeOf } from 'expect-type'

// Deliberately wrong (B01 acceptance): this must fail the type-test job. Reverted next commit.
expectTypeOf<string>().toEqualTypeOf<number>()
