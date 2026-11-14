import { main } from '../src/cli.ts'
import { greet } from '../src/greet.js'

test('greets ada', () => {
  expect(greet('ada')).toBe('hello ada')
})

test('runs with an argument', () => {
  expect(main(['x'])).toBe(0)
})
