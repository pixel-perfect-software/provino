// A tagged template built by hand: Vitest reports a multi-line template's location from its
// transformed code (see each-templates).
function table(headings: readonly string[], rows: readonly (readonly unknown[])[]) {
  const strings: string[] = [`\n  ${headings.join(' | ')}\n  `]
  const cells = rows.flat()
  for (let index = 1; index < cells.length; index++) {
    strings.push(index % headings.length === 0 ? '\n  ' : ' | ')
  }
  strings.push('\n')
  return [Object.assign(strings, { raw: strings }), ...cells] as const
}

test.for([
  [1, 2],
  [3, 4],
])('array rows: %s %s %#', () => {})
test.for([{ a: 1 }, { a: 'x', b: { c: 2 } }])('object rows: $a $b.c $#', () => {})
test.for([1, 'x', true, 0])('bare rows: %s %p %#', () => {})
test.for([[{ a: 'first' }, 'second']])('array row with an object first: $a $0 $1 %s', () => {})
test.for(
  ...table(
    ['a', 'b'],
    [
      [1, { c: 'd' }],
      [2, [1, 2]],
    ],
  ),
)('template rows: $a $b $b.c $#', () => {})

describe.for([
  [1, 'a'],
  [2, 'b'],
])('describe array rows: %d %s %#', () => {
  test('inner', () => {})
})
describe.for([{ a: 1 }, { a: 2 }])('describe object rows: $a $#', () => {
  test('inner', () => {})
})
