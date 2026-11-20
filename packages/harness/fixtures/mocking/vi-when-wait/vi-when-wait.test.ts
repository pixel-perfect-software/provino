// vi.when, vi.isWhenChain, vi.waitFor and vi.waitUntil, one observation a test.
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

c('when returns per argument and falls back for others', () => {
  const f = vi.fn((x: number) => `impl ${x}`)
  const chain = vi.when(f).calledWith(1).thenReturn('one')
  return { first: f(1), other: f(2), isChain: vi.isWhenChain(chain), plain: vi.isWhenChain({}) }
})

c('when with thenReturnOnce and thenThrow', () => {
  const f = vi.fn()
  vi.when(f).calledWith('a').thenReturnOnce('once')
  vi.when(f).calledWith('b').thenThrow(new Error('b throws'))
  return [f('a'), f('a'), attempt(() => f('b'))]
})

c('when with onUnmatched throw', () => {
  const f = vi.fn()
  vi.when(f, { onUnmatched: 'throw' }).calledWith(1).thenReturn('one')
  return [attempt(() => f(1)), attempt(() => f(2))]
})

c('waitFor resolves with the callback value at once', async () => {
  let calls = 0
  const value = await vi.waitFor(() => {
    calls++
    return 'ready'
  })
  return { value, calls }
})

c('waitUntil resolves with the first truthy value', async () => {
  let calls = 0
  const value = await vi.waitUntil(() => {
    calls++
    return { ok: true }
  })
  return { value, calls }
})
