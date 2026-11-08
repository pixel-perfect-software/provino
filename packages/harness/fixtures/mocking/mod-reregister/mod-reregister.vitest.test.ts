const g = globalThis as { runs?: string[] }
g.runs = []

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

vi.doMock('./target.ts', () => {
  g.runs?.push('first')
  return { who: 'first' }
})

c('the first load runs the first factory', async () => ({
  who: ((await import('./target.ts')) as { who: string }).who,
  runs: g.runs,
}))

c('a second doMock after the load: the next load, with no reset', async () => {
  vi.doMock('./target.ts', () => {
    g.runs?.push('second')
    return { who: 'second' }
  })
  return { who: ((await import('./target.ts')) as { who: string }).who, runs: g.runs }
})

c('after resetModules the second factory runs', async () => {
  vi.resetModules()
  return { who: ((await import('./target.ts')) as { who: string }).who, runs: g.runs }
})

c('two doMocks before any load: the last one wins and the first never runs', async () => {
  vi.resetModules()
  vi.doMock('./target.ts', () => {
    g.runs?.push('third')
    return { who: 'third' }
  })
  vi.doMock('./target.ts', () => {
    g.runs?.push('fourth')
    return { who: 'fourth' }
  })
  return { who: ((await import('./target.ts')) as { who: string }).who, runs: g.runs }
})
