const m = require('./src/foo.ts') as Record<string, unknown>

test('plain', () => {
  expect(m).toBeDefined()
})
