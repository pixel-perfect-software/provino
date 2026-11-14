test('property matchers', () => {
  expect({ id: 7, name: 'x' }).toMatchInlineSnapshot({ id: expect.any(Number) })
  expect({ id: 8, when: new Date(0) }).toMatchInlineSnapshot({
    id: expect.any(Number),
    when: expect.any(Date),
  })
})

test('a call over several lines', () => {
  // biome-ignore format: the call keeps its own layout
  expect(
    { spread: [1, 2, 3] },
  ).toMatchInlineSnapshot(
    // where the snapshot goes
  )
})
