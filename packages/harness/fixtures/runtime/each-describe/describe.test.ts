describe.each([
  [1, 'a'],
  [2, 'b'],
])('rows: %d %s %# %$', (n, s) => {
  test(`inner ${n}${s}`, () => {})
  test.each([[n, s]])('nested: %s/%s', () => {})
})

describe.each([1, 'two', { three: 3 }, null])('bare: %s %p', () => {
  test('inner', () => {})
})

describe.each([{ a: 1 }, { a: 'x', b: { c: 2 } }])('objects: $a $b.c $#', () => {
  test('inner', () => {})
})

describe.each([{ a: 1 }, { a: 'x', b: { c: 2 } }])('objects with tokens: %s $a', () => {
  test('inner', () => {})
})

describe.each`
  a    | b
  ${1} | ${{ c: 'd' }}
  ${2} | ${[1, 2]}
`('template: $a $b $b.c $#', ({ a }) => {
  test(`inner ${a}`, () => {})
})

describe.each([[1], [2]])('outer %#', (n) => {
  describe.each([['x'], ['y']])('inner %s of %j', (letter) => {
    test('leaf %s', () => {})
    test.each([[n, letter]])('leaf each %s %s %# %%', () => {})
  })
})

describe.each([['50% off', '%s']])('percent: %s | %s | 100%%', () => {
  test('inner', () => {})
})
