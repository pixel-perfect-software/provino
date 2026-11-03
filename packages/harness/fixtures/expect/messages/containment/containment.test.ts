describe('toContain', () => {
  test('toContain array without the item', () => {
    expect([1, 2, 3]).toContain(4)
  })

  test('toContain string without the substring', () => {
    expect('hello world').toContain('planet')
  })

  test('toContain an equal object hints toContainEqual', () => {
    expect([{ a: 1 }]).toContain({ a: 1 })
  })

  test('not.toContain array with the item', () => {
    expect([1, 2, 3]).not.toContain(2)
  })

  test('not.toContain string with the substring', () => {
    expect('hello world').not.toContain('world')
  })

  test('toContain with a null received is a matcher error', () => {
    expect(null).toContain(1)
  })
})

describe('toContainEqual', () => {
  test('toContainEqual without an equal item', () => {
    expect([{ a: 1 }, { b: 2 }]).toContainEqual({ a: 2 })
  })

  test('not.toContainEqual with an equal item', () => {
    expect([{ a: 1 }]).not.toContainEqual({ a: 1 })
  })
})

describe('toHaveLength', () => {
  test('toHaveLength array of another length', () => {
    expect([1, 2]).toHaveLength(3)
  })

  test('toHaveLength string of another length', () => {
    expect('abc').toHaveLength(2)
  })

  test('not.toHaveLength the same length', () => {
    expect([1]).not.toHaveLength(1)
  })

  test('toHaveLength with a number received is a matcher error', () => {
    expect(5).toHaveLength(1)
  })
})

describe('toMatch', () => {
  test('toMatch a regex that does not match', () => {
    expect('abc').toMatch(/d/)
  })

  test('toMatch a string that is not a substring', () => {
    expect('abc').toMatch('xyz')
  })

  test('not.toMatch a regex that matches', () => {
    expect('abc').not.toMatch(/b/)
  })

  test('toMatch with a number received is a matcher error', () => {
    expect(1).toMatch(/1/)
  })
})
