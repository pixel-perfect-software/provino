const m = require('./b.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
