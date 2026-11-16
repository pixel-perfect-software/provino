test('the setup module from NODE_PATH ran', () => {
  expect(globalThis.__MARK__).toBe('from NODE_PATH')
})
