test.each`
  a    | b
  ${1} | ${{ c: 'd' }}
  ${2} | ${[1, 2]}
`('template: $a $b $b.c $#', () => {})

test.each`
  a             | b         | expected
  ${1}          | ${1}      | ${2}
  ${'x'}        | ${null}   | ${undefined}
  ${{ k: 'v' }} | ${[1, 2]} | ${new Date(0)}
`('$a + $b = $expected / $#', () => {})

describe.each`
  a    | b
  ${1} | ${'one'}
  ${2} | ${'two'}
`('describe template: $a $b $#', () => {
  test('inner', () => {})
})
