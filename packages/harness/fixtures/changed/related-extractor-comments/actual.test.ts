const m = jest.requireActual('./src/foo.ts') as Record<string, unknown>

test('actual', () => {
  expect(m).toBeDefined()
})
