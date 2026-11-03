class Owner {}

describe('asymmetric matchers inside toEqual', () => {
  test('any Number against a string property', () => {
    expect({ id: 'x' }).toEqual({ id: expect.any(Number) })
  })

  test('any a class against a plain object', () => {
    expect({ owner: {} }).toEqual({ owner: expect.any(Owner) })
  })

  test('any inside an array', () => {
    expect([1, 'two']).toEqual([expect.any(Number), expect.any(Number)])
  })

  test('anything against null', () => {
    expect({ value: null }).toEqual({ value: expect.anything() })
  })

  test('objectContaining a missing property', () => {
    expect({ a: 1, b: 2 }).toEqual(expect.objectContaining({ c: 3 }))
  })

  test('arrayContaining a missing item', () => {
    expect([1, 2]).toEqual(expect.arrayContaining([3]))
  })

  test('stringContaining a missing substring', () => {
    expect({ text: 'hello' }).toEqual({ text: expect.stringContaining('bye') })
  })

  test('stringMatching a regex that does not match', () => {
    expect('hello').toEqual(expect.stringMatching(/^bye/))
  })

  test('closeTo a value outside the precision', () => {
    expect({ total: 0.5 }).toEqual({ total: expect.closeTo(0.6, 2) })
  })

  test('not.objectContaining a matching subset', () => {
    expect({ a: 1, b: 2 }).toEqual(expect.not.objectContaining({ a: 1 }))
  })

  test('not.arrayContaining a matching subset', () => {
    expect([1, 2, 3]).toEqual(expect.not.arrayContaining([2]))
  })

  test('not.stringContaining a present substring', () => {
    expect('hello').toEqual(expect.not.stringContaining('ell'))
  })

  test('not.stringMatching a regex that matches', () => {
    expect('hello').toEqual(expect.not.stringMatching(/^h/))
  })
})
