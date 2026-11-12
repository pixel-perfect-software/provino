// One check per test: a status in the golden is Jest's verdict on it.
const load = (name: string): Record<string, unknown> => require(name)

test('a mapper rule for @jest/expect is used', () => {
  expect(load('@jest/expect').which).toBe('stub')
})
