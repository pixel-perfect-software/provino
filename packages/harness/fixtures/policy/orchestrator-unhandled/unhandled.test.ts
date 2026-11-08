// A passing test, and an afterAll that throws.
test('passes', () => {})

afterAll(() => {
  throw new Error('afterAll failed')
})
