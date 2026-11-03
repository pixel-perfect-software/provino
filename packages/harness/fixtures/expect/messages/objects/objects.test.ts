describe('toHaveProperty', () => {
  test('toHaveProperty a missing dotted path', () => {
    expect({ a: { b: 1 } }).toHaveProperty('a.c')
  })

  test('toHaveProperty a path with a wrong value', () => {
    expect({ a: { b: 1 } }).toHaveProperty('a.b', 2)
  })

  test('toHaveProperty an array path with a wrong value', () => {
    expect({ a: { b: [1, 2] } }).toHaveProperty(['a', 'b', 1], 3)
  })

  test('toHaveProperty a missing array path', () => {
    expect({ a: {} }).toHaveProperty(['a', 'x', 'y'])
  })

  test('not.toHaveProperty an existing path', () => {
    expect({ a: 1 }).not.toHaveProperty('a')
  })

  test('not.toHaveProperty an existing path and value', () => {
    expect({ a: { b: 'x' } }).not.toHaveProperty('a.b', 'x')
  })
})

describe('toMatchObject', () => {
  test('toMatchObject nested diff', () => {
    expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 5 } })
  })

  test('toMatchObject arrays of objects', () => {
    expect([{ a: 1 }, { b: 2 }]).toMatchObject([{ a: 1 }, { b: 3 }])
  })

  test('toMatchObject a missing property', () => {
    expect({ a: 1 }).toMatchObject({ a: 1, z: true })
  })

  test('not.toMatchObject a subset', () => {
    expect({ a: 1, b: 2 }).not.toMatchObject({ a: 1 })
  })

  test('toMatchObject with a number received is a matcher error', () => {
    expect(1).toMatchObject({ a: 1 })
  })
})
