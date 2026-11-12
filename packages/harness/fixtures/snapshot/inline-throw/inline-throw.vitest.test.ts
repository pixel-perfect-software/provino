test('inline throw', () => {
  expect(() => {
    throw new Error('e')
  }).toThrowErrorMatchingInlineSnapshot(`[Error: e]`)
})
