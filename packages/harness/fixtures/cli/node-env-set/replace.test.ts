test(`replaceProperty swaps NODE_ENV (loaded as ${process.env.NODE_ENV}) and restore puts it back`, () => {
  const replaced = jest.replaceProperty(process.env, 'NODE_ENV', 'development')
  expect(process.env.NODE_ENV).toBe('development')
  replaced.restore()
  expect(process.env.NODE_ENV).toBe('production')
})
