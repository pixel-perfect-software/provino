const m = { ...require('./src/foo.ts') } as unknown

test('spread', () => {
  expect(m).toBeDefined()
})
