const m = require('./src/types.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
