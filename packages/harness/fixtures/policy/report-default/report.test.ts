// A failing test inside a describe, for the default reporter's failure line.
describe('the suite', () => {
  test('the failing test', () => {
    throw new Error('failed')
  })
})
