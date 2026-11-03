// expect.arrayOf is new in Jest 30; Vitest 5 has no such matcher.
describe('arrayOf', () => {
  test('arrayOf with an item that does not match', () => {
    expect([1, 'two', 3]).toEqual(expect.arrayOf(expect.any(Number)))
  })

  test('not.arrayOf with every item matching', () => {
    expect([1, 2]).toEqual(expect.not.arrayOf(expect.any(Number)))
  })
})
