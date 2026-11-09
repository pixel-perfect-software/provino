test('runs', () => {
  expect('ran').toMatchSnapshot()
})

test('filtered out', () => {
  expect('left out').toMatchSnapshot()
})
