const m = require('./src/b.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
