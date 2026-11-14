import { greet } from '../src/greet.ts'

test('greets the world', () => {
  expect(greet()).toBe('hello world')
})
