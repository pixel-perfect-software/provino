// T5.4: the Vitest dialect's `.each` title formatter, the one function `/runtime` adds for it, and
// the number of characters it keeps of a value.
import { VITEST_EACH_TITLE_TRUNCATE } from '@provino/dialect-vitest'
import { formatEachTitle } from '@provino/dialect-vitest/runtime'
import type { FormatEachTitle } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(formatEachTitle).toEqualTypeOf<FormatEachTitle>()
expectTypeOf(formatEachTitle).parameters.toEqualTypeOf<
  [
    template: string,
    row: readonly unknown[] | Readonly<Record<string, unknown>>,
    index: number,
    kind?: 'rows' | 'template' | 'mixed' | undefined,
  ]
>()
expectTypeOf(formatEachTitle).returns.toBeString()
expectTypeOf(VITEST_EACH_TITLE_TRUNCATE).toBeNumber()

// @ts-expect-error a title is a string
formatEachTitle(1, [1], 0)
// @ts-expect-error a row is an array or an object, not a bare value
formatEachTitle('%s', 1, 0)
// @ts-expect-error the index is a number
formatEachTitle('%s', [1], '0')
// @ts-expect-error a table kind outside rows, template and mixed is refused
formatEachTitle('%s', [1], 0, 'list')
