test('inline throw', () => {
  expect(() => {
    throw new Error('e')
  }).toThrowErrorMatchingInlineSnapshot(`"e"`)
})
