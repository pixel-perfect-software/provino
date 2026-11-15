const { double } = require('../src/changed.ts')
const { name } = require('../src/shared.ts')

test('doubles', () => {
  expect(double(2)).toBe(4)
  expect(name).toBe('shared')
})
