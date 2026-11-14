const m = require('./src/index.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
