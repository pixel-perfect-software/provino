const g = globalThis as Record<string, unknown>

test('a setup file sees real time', () => {
  expect(g.__setupNow).not.toBe(123456)
  expect(g.__setupNow as number).toBeGreaterThan(1_000_000_000_000)
})

test('a setupFilesAfterEnv file sees the fixed time', () => {
  expect(g.__afterEnvNow).toBe(123456)
})
