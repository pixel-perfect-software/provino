import { greet } from 'cjs-pkg'

test('the CommonJS package loads', () => {
  expect(greet('jest')).toBe('hello jest!')
})
