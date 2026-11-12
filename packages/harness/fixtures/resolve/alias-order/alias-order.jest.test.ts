// One check per test: a status in the golden is Jest's verdict on it.
const load = (name: string): Record<string, unknown> => require(name)

test('@jest/globals is answered before the mapper', () => {
  expect(load('@jest/globals').jest).toBe(jest)
  expect(load('@jest/globals').which).toBeUndefined()
})
test('a mapper rule for an installed bare package name is used', () => {
  expect(load('bare-pkg').which).toBe('stub')
})
