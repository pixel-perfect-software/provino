describe('it.each over an array', () => {
  it.each([
    [1, 1, 2],
    [2, 3, 6],
  ])('%i + %i = %i', (a, b, sum) => {
    expect(a + b).toBe(sum)
  })

  it.each(['alpha', 'beta'])('name %s', (name) => {
    expect(typeof name).toBe('string')
  })
})

describe('it.each over a template', () => {
  it.each`
    a    | b    | sum
    ${1} | ${1} | ${2}
    ${2} | ${2} | ${4}
  `('$a + $b = $sum', ({ a, b, sum }) => {
    expect(a + b).toBe(sum)
  })
})

describe('duplicate names', () => {
  it.each([1, 2, 3])('same name', (n) => {
    expect(n).toBeGreaterThan(0)
  })
})

describe('it.each over objects', () => {
  it.each([
    { name: 'one', value: 1 },
    { name: 'two', value: 2 },
  ])('object $name', ({ value }) => {
    expect(value).toBeGreaterThan(0)
  })
})
