test('dynamic', async () => {
  const m = await import('./src/foo.ts')
  expect(m).toBeDefined()
})
