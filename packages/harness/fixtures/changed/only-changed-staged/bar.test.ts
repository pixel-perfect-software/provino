const m = require('./src/bar.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
