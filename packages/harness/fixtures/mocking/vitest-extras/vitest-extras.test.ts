// What only Vitest 5.0 has: mockThrow and mockThrowOnce, stubEnv, stubGlobal and the two unstubs.
const attempt = (run: () => unknown) => {
  try {
    return { value: run() }
  } catch (error) {
    return { threw: error }
  }
}
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('mockThrow makes every call throw and records the throw', () => {
  const f = vi.fn(() => 'impl')
  const returned = f.mockThrow(new Error('always'))
  return {
    returnsSelf: returned === f,
    first: attempt(() => f()),
    second: attempt(() => f()),
    results: f.mock.results,
  }
})

c('mockThrowOnce throws once and then falls back', () => {
  const f = vi.fn(() => 'impl')
  f.mockThrowOnce(new Error('once'))
  return [attempt(() => f()), attempt(() => f())]
})

c('mockThrow with a value that is not an error', () => {
  const f = vi.fn()
  f.mockThrow('just a string')
  return attempt(() => f())
})

c('stubEnv sets a variable and unstubAllEnvs removes one that did not exist', () => {
  const before = process.env.PROVINO_STUB_NEW
  const returned = vi.stubEnv('PROVINO_STUB_NEW', 'stubbed')
  const during = process.env.PROVINO_STUB_NEW
  vi.unstubAllEnvs()
  return { before, during, after: process.env.PROVINO_STUB_NEW, returnsVi: returned === vi }
})

c('unstubAllEnvs restores the value a variable had', () => {
  process.env.PROVINO_STUB_EXISTING = 'original'
  vi.stubEnv('PROVINO_STUB_EXISTING', 'changed')
  const during = process.env.PROVINO_STUB_EXISTING
  vi.unstubAllEnvs()
  const after = process.env.PROVINO_STUB_EXISTING
  delete process.env.PROVINO_STUB_EXISTING
  return { during, after }
})

c('stubEnv with a value that is not a string', () => {
  const result = attempt(() => {
    vi.stubEnv('PROVINO_STUB_NUMBER', 5 as never)
    return process.env.PROVINO_STUB_NUMBER
  })
  vi.unstubAllEnvs()
  return result
})

c('stubGlobal sets a global and unstubAllGlobals removes one that did not exist', () => {
  const target = globalThis as Record<string, unknown>
  const before = 'provinoStubbed' in target
  const returned = vi.stubGlobal('provinoStubbed', 42)
  const during = target.provinoStubbed
  vi.unstubAllGlobals()
  return { before, during, after: 'provinoStubbed' in target, returnsVi: returned === vi }
})

c('unstubAllGlobals restores the value a global had', () => {
  const target = globalThis as Record<string, unknown>
  target.provinoOriginal = 'original'
  vi.stubGlobal('provinoOriginal', 'changed')
  const during = target.provinoOriginal
  vi.unstubAllGlobals()
  const after = target.provinoOriginal
  delete target.provinoOriginal
  return { during, after }
})
