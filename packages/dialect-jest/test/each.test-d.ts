// T5.4: the Jest dialect's `.each` title formatter, which `/runtime` exports for the policy's
// `core.formatEachTitle`, and the table kind its optional fourth argument takes.
import { type EachTableKind, formatEachTitle } from '@provino/dialect-jest/runtime'
import type { FormatEachTitle } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// It is a `FormatEachTitle`, with one optional argument more.
expectTypeOf(formatEachTitle).toExtend<FormatEachTitle>()
expectTypeOf(formatEachTitle).toEqualTypeOf<
  (
    template: string,
    row: readonly unknown[] | Readonly<Record<string, unknown>>,
    index: number,
    kind?: EachTableKind,
  ) => string
>()
expectTypeOf<EachTableKind>().toEqualTypeOf<'rows' | 'template' | 'mixed'>()

formatEachTitle('%s', ['a'], 0)
formatEachTitle('$a', { a: 1 }, 0, 'template')

// @ts-expect-error a table kind outside the three is refused
formatEachTitle('$a', { a: 1 }, 0, 'list')
// @ts-expect-error a title is a string
formatEachTitle(1, [1], 0)
// @ts-expect-error a row is an array or an object, not a bare value
formatEachTitle('%s', 1, 0)
// @ts-expect-error the index is a number
formatEachTitle('%s', [1], '0')
