const m = require('./src/foo.ts') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
