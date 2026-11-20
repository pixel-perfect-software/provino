// The public API of @provino/expect/table.

import { provinoExpectTable } from '@provino/expect/table'
import type { ExpectTable, MatcherTableFactory } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(provinoExpectTable).toEqualTypeOf<MatcherTableFactory>()
expectTypeOf(provinoExpectTable()).toExtend<ExpectTable>()

// @ts-expect-error the factory takes no argument
provinoExpectTable('jest')

// @ts-expect-error a table is not a function
provinoExpectTable()()

// @ts-expect-error the matcher sets are read-only values, not a name to look up
provinoExpectTable().matchers.toBe.call
