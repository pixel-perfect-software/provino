describe.each([
  ['first', 1],
  ['second', 2],
])('group %s', (_label, n) => {
  it('has a number', () => {
    expect(typeof n).toBe('number')
  })

  it('is positive', () => {
    expect(n).toBeGreaterThan(0)
  })
})

describe.each`
  size       | count
  ${'small'} | ${1}
  ${'large'} | ${3}
`('table $size', ({ count }) => {
  it('counts', () => {
    expect(count).toBeGreaterThan(0)
  })
})
