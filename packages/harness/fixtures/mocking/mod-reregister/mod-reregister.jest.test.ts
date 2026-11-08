const g = globalThis as { runs?: string[] }
g.runs = []

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

jest.doMock('./target.ts', () => {
  g.runs?.push('first')
  return { who: 'first' }
})

c('the first load runs the first factory', () => ({
  who: (require('./target.ts') as { who: string }).who,
  runs: g.runs,
}))

c('a second doMock after the load: the next load, with no reset', () => {
  jest.doMock('./target.ts', () => {
    g.runs?.push('second')
    return { who: 'second' }
  })
  return { who: (require('./target.ts') as { who: string }).who, runs: g.runs }
})

c('after resetModules the second factory runs', () => {
  jest.resetModules()
  return { who: (require('./target.ts') as { who: string }).who, runs: g.runs }
})

c('two doMocks before any load: the last one wins and the first never runs', () => {
  jest.resetModules()
  jest.doMock('./target.ts', () => {
    g.runs?.push('third')
    return { who: 'third' }
  })
  jest.doMock('./target.ts', () => {
    g.runs?.push('fourth')
    return { who: 'fourth' }
  })
  return { who: (require('./target.ts') as { who: string }).who, runs: g.runs }
})
