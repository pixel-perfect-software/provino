describe('writes inline', () => {
  test('into the call', () => {
    expect({ a: 1, list: [1, 2] }).toMatchInlineSnapshot()
    expect('x').toMatchInlineSnapshot()
  })
})
