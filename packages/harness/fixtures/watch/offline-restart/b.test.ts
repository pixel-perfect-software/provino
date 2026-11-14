const { b } = require('./src/b.ts') as { b: number }

test('b', () => {
  expect(b).toBeGreaterThan(0)
})
