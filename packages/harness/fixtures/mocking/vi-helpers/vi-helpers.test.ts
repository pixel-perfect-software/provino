// The vi members the other mocking fixtures leave out, one observation a test.
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

const hoistedValue = vi.hoisted(() => ({ made: 'hoisted' }))

c('defineHelper returns a function that calls the helper', () => {
  const helper = vi.defineHelper((a: number, b: number) => a + b)
  return { type: typeof helper, result: helper(2, 3) }
})

c('hoisted returns the factory value', () => hoistedValue)

c('mockObject mocks methods deeply and keeps values', () => {
  const mocked = vi.mockObject({ n: 1, method: () => 'real', nested: { inner: () => 'inner' } })
  return {
    n: mocked.n,
    method: mocked.method(),
    isMock: vi.isMockFunction(mocked.method),
    nested: vi.isMockFunction(mocked.nested.inner),
  }
})

c('mockObject with spy keeps the implementations', () => {
  const mocked = vi.mockObject({ method: () => 'real' }, { spy: true })
  return { method: mocked.method(), calls: vi.mocked(mocked.method).mock.calls.length }
})

c('dynamicImportSettled resolves to undefined', async () => ({
  value: await vi.dynamicImportSettled(),
}))

c('setConfig and resetConfig return nothing', () => {
  const returned = vi.setConfig({ testTimeout: 1234 })
  const reset = vi.resetConfig()
  return { returned, reset }
})
