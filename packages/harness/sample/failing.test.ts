// Jest calls it `test.failing` and Vitest `test.fails`.
const failing = typeof jest === 'undefined' ? test.fails : test.failing

failing('fails, as it is meant to', () => {
  expect(1).toBe(2)
})

failing('passes, so it fails', () => {
  expect(1).toBe(1)
})
