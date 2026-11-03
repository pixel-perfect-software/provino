// The public API of @provino/dialect-jest (B08: the `expect` slice).
import { jestExpectPolicy } from '@provino/dialect-jest'
import { jestExpectTable } from '@provino/dialect-jest/runtime'
import type { ExpectPolicy, ExpectTable, MatcherTableFactory } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(jestExpectPolicy).toEqualTypeOf<ExpectPolicy>()
expectTypeOf(jestExpectTable).toExtend<MatcherTableFactory>()
expectTypeOf(jestExpectTable).returns.toEqualTypeOf<ExpectTable>()

// @ts-expect-error the factory takes no arguments
jestExpectTable({})
// @ts-expect-error the policy is read-only
jestExpectPolicy.expand = true
