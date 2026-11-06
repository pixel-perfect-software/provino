const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('doMock applies to the next load of a module that was not loaded yet', async () => {
  vi.doMock('./fresh.ts', () => ({ who: 'mock-fresh' }))
  const fresh = (await import('./fresh.ts')) as { who: string }
  return { who: fresh.who }
})

c('doMock after a load: the next load sees the mock with or without resetModules', async () => {
  const before = (await import('./loaded.ts')) as { who: string }
  vi.doMock('./loaded.ts', () => ({ who: 'mock-loaded' }))
  const same = (await import('./loaded.ts')) as { who: string }
  vi.resetModules()
  const after = (await import('./loaded.ts')) as { who: string }
  return { before: before.who, withoutReset: same.who, afterReset: after.who }
})
