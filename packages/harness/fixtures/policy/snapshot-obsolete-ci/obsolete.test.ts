// Checks one stored snapshot; the .snap also holds one nothing checks.
test('kept', () => {
  expect('kept').toMatchSnapshot()
})
