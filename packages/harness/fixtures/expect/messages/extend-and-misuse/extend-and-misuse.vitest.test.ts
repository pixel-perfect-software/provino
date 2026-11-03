// Vitest's side of `expect(a, b)`: the second argument is a message that prefixes the failure.
describe('misuse', () => {
  test('expect with a message argument', () => {
    expect(1, 'the custom message').toBe(2)
  })
})
