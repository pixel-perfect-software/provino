// What the jest object's module-registry calls return.
test('the module-registry calls', async () => {
  await observe(
    'jest.isolateModules returns the jest object',
    () => jest.isolateModules(() => {}) === jest,
  )
  await observe('jest.resetModules returns the jest object', () => jest.resetModules() === jest)
  await observe('jest.isolateModulesAsync returns a promise of undefined', async () => {
    const returned = jest.isolateModulesAsync(async () => {})
    const isPromise = typeof (returned as { then?: unknown }).then === 'function'
    return { isPromise, resolvesTo: await returned }
  })
  await observe('isolateModules inside isolateModules', () => {
    let thrown: unknown
    jest.isolateModules(() => {
      try {
        jest.isolateModules(() => {})
      } catch (error) {
        thrown = error
      }
    })
    return thrown
  })
})
