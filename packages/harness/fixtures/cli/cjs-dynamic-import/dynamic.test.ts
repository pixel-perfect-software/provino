it('loads a module with import() from a CommonJS file', async () => {
  const loaded = await import('./loaded.ts')
  expect(loaded.value).toBe(42)
})
