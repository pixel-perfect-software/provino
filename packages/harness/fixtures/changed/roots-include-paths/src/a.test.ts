const m = require('./a.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
