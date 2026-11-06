// What a mock function records. One observation per case; the file runs under Jest and Vitest, so
// the mock global is picked at run time. The first case reads absolute call orders, so it must stay
// first: both engines count across the whole file.
const M = typeof jest === 'undefined' ? vi : jest
const show = (context: unknown) =>
  context === undefined ? '<undefined>' : context === globalThis ? '<global>' : context
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('invocationCallOrder counts from 1 across mocks', () => {
  const a = M.fn()
  const b = M.fn()
  a()
  b()
  a()
  return { a: a.mock.invocationCallOrder, b: b.mock.invocationCallOrder }
})

c('calls hold the argument references', () => {
  const f = M.fn()
  const arg = { n: 1 }
  f(arg, 2)
  f()
  return { calls: f.mock.calls, sameReference: f.mock.calls[0][0] === arg }
})

c('results hold return values, with undefined for no return', () => {
  const f = M.fn((n: number) => (n > 0 ? n * 2 : undefined))
  f(2)
  f(0)
  return f.mock.results
})

c('a call is incomplete until its implementation returns', () => {
  let during: unknown
  const f = M.fn(() => {
    during = {
      results: f.mock.results.map((r: object) => ({ ...r })),
      calls: f.mock.calls.length,
    }
    return 'done'
  })
  f('a')
  return { during, after: f.mock.results }
})

c('a thrown error is a throw result and the call is still recorded', () => {
  const f = M.fn(() => {
    throw new Error('boom')
  })
  let caught: unknown
  try {
    f(1)
  } catch (error) {
    caught = error
  }
  return { caught, calls: f.mock.calls, results: f.mock.results }
})

c('contexts hold the receiver of each call', () => {
  const owner = { f: M.fn() }
  const other = { tag: 'other' }
  owner.f()
  owner.f.call(other)
  return owner.f.mock.contexts.map((context: unknown) =>
    context === owner ? '<owner>' : show(context),
  )
})

c('instances hold the receiver of each call too', () => {
  const owner = { f: M.fn() }
  owner.f()
  return {
    instances: owner.f.mock.instances.map((i: unknown) => (i === owner ? '<owner>' : show(i))),
    sameAsContexts: owner.f.mock.instances[0] === owner.f.mock.contexts[0],
  }
})

c('lastCall is the newest call, and undefined before any', () => {
  const f = M.fn()
  const before = f.mock.lastCall
  f(1)
  f(2, 3)
  return { before, after: f.mock.lastCall }
})

c('settledResults follow an async implementation', async () => {
  const f = M.fn(async (ok: boolean) => {
    if (!ok) throw new Error('rejected')
    return 'fine'
  })
  const pending = f(true)
  const duringPending = f.mock.settledResults?.map((r: object) => ({ ...r }))
  await pending
  await f(false).catch(() => undefined)
  return {
    duringPending,
    settled: f.mock.settledResults,
    results: f.mock.results.map((r: { type: string }) => r.type),
  }
})

c('mockClear inside the implementation wipes the call in flight', () => {
  const f = M.fn(() => {
    f.mockClear()
    return 'after clear'
  })
  const returned = f('x')
  return { returned, calls: f.mock.calls, results: f.mock.results }
})

c('calls recorded after a clear start a fresh list', () => {
  const f = M.fn()
  f(1)
  f.mockClear()
  f(2)
  return { calls: f.mock.calls, order: f.mock.invocationCallOrder.length }
})
