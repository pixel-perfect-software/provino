const { a } = require('./src/a.ts') as { a: number }

test('a', () => {
  expect(a).toBeGreaterThan(0)
})
