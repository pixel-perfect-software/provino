test('two calls on one line', () => {
  // biome-ignore format: the two calls must stay on one line
  const calls = [expect(1).toMatchInlineSnapshot(), expect('b').toMatchInlineSnapshot()]
  expect(calls).toHaveLength(2)
})
