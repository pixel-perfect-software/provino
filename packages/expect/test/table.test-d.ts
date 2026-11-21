// The public API of @provino/expect/table.

import { provinoExpectTable } from '@provino/expect/table'
import type { ExpectTable, Matchers, MatcherTableFactory } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(provinoExpectTable).toEqualTypeOf<MatcherTableFactory>()
expectTypeOf(provinoExpectTable()).toExtend<ExpectTable>()

// @ts-expect-error the factory takes no argument
provinoExpectTable('jest')

// @ts-expect-error a table is not a function
provinoExpectTable()()

// @ts-expect-error the matcher sets are read-only values, not a name to look up
provinoExpectTable().matchers.toBe.call

// toBeTypeOf and toSatisfy (B27c): the names typeof gives, and a predicate.
declare const matchers: Matchers
matchers.toBeTypeOf('string')
matchers.toSatisfy((value: number) => value > 0)
// @ts-expect-error not a name typeof gives
matchers.toBeTypeOf('array')
// @ts-expect-error the predicate is a function
matchers.toSatisfy(5)
// @ts-expect-error toHaveNthReturnedWith takes the return number first
matchers.toHaveNthReturnedWith('x')
