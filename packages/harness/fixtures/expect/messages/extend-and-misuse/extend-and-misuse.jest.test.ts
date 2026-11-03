// Misuse that only Jest rejects: Vitest takes a message as the second argument and keeps the
// aliases Jest 30 removed. Fixture types are stripped, never checked.
describe('misuse', () => {
  test('expect with two arguments', () => {
    expect(1, 'extra').toBe(1)
  })

  test('toBeCalled is not a function in Jest 30', () => {
    const fn = jest.fn()
    fn()
    expect(fn).toBeCalled()
  })
})
