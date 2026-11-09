// Vitest reports the location of a multi-line tagged template from its transformed code, where the
// lines no longer add up (the offset grows with each template), so the tables here are built by
// hand: a tag is called with the template's strings (an array with a `raw`) and its values, which
// is all either runner reads. `each-template-syntax` has the literal syntax, for Jest.
function table(headings: readonly string[], rows: readonly (readonly unknown[])[]) {
  const strings: string[] = [`\n  ${headings.join(' | ')}\n  `]
  const cells = rows.flat()
  for (let index = 1; index < cells.length; index++) {
    strings.push(index % headings.length === 0 ? '\n  ' : ' | ')
  }
  strings.push('\n')
  return [Object.assign(strings, { raw: strings }), ...cells] as const
}

const titles = [
  'plain title',
  '$a + $b = $expected',
  '$a|$b|$expected',
  '$# $a',
  '$a.k $b.0 $expected.nope',
  '$expected.getTime',
  'missing $zz and $a.zz',
  '$',
  '$a. $b.',
]

for (const title of titles) {
  test.each(
    ...table(
      ['a', 'b', 'expected'],
      [
        [1, 1, 2],
        ['x', null, undefined],
        [{ k: 'v' }, [1, 2], new Date(0)],
        [true, -0, Number.NaN],
        ['50% off', '$a', '%s'],
        [10, Symbol('s'), () => {}],
      ],
    ),
  )(title, () => {})
}

// One column, and headings where one is the start of another.
test.each(...table(['a'], [[1], ['two'], [{ three: 3 }]]))('one column $a $# $zz', () => {})
test.each(
  ...table(
    ['id', 'idx', 'identifier'],
    [
      [1, 2, 3],
      ['a', 'b', 'c'],
    ],
  ),
)('$id $idx $identifier $i $ide', () => {})

test.each(
  ...table(
    ['a', 'b'],
    [
      [{ deep: { deeper: { deepest: 1 } } }, [[1, [2, [3]]]]],
      [new Map([[1, 2]]), new Set([1])],
      [/x/g, new Date(Number.NaN)],
    ],
  ),
)('$a | $b', () => {})

test.each(...table(['a', 'b'], [[{ deep: { deeper: { deepest: 1 } } }, [[1, [2, [3]]]]]]))(
  '$a.deep | $a.deep.deeper.deepest | $b.0 | $b.0.1',
  () => {},
)

// A wider table.
test.each(
  ...table(
    ['w', 'x', 'y', 'z'],
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ],
  ),
)('$w$x$y$z / $z $y $x $w', () => {})
