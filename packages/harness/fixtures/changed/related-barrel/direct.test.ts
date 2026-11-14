const m = require('./src/y.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
