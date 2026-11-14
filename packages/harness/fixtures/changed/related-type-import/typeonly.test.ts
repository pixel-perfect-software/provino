import type { T } from './src/types.ts'

test('type only', () => {
  const t: T | undefined = undefined
  expect(t).toBeUndefined()
})
