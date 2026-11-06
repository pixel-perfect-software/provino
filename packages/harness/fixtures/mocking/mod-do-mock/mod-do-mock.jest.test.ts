const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('doMock applies to the next load of a module that was not loaded yet', () => {
  jest.doMock('./fresh.ts', () => ({ who: 'mock-fresh' }))
  const fresh = require('./fresh.ts') as { who: string }
  return { who: fresh.who }
})

c('doMock after a load: the next load sees the mock with or without resetModules', () => {
  const before = require('./loaded.ts') as { who: string }
  jest.doMock('./loaded.ts', () => ({ who: 'mock-loaded' }))
  const same = require('./loaded.ts') as { who: string }
  jest.resetModules()
  const after = require('./loaded.ts') as { who: string }
  return { before: before.who, withoutReset: same.who, afterReset: after.who }
})
