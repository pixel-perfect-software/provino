describe('new inline snapshots', () => {
  test('values of each kind', () => {
    expect({ a: 1, nested: { list: [1, 'two'] } }).toMatchInlineSnapshot()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the snapshot must escape it
    expect('a `backtick`, a ${dollar} and a \\ slash').toMatchInlineSnapshot()
    expect('line one\nline two').toMatchInlineSnapshot()
    expect(42).toMatchInlineSnapshot()
    expect(undefined).toMatchInlineSnapshot()
  })

  test('in a nested function', () => {
    const check = (value) => {
      expect(value).toMatchInlineSnapshot()
    }
    check([1, 2])
  })
})

test('at the top level', () => {
  expect(new Map([['k', 1]])).toMatchInlineSnapshot()
})
