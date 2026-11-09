test('stored', () => {
  expect({ a: 1 }).toMatchSnapshot()
})

test('stored with hint', () => {
  expect('text').toMatchSnapshot('hint')
})
