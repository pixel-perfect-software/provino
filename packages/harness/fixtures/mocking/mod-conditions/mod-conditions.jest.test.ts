const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a factory for a package with only a require condition', () => {
  jest.doMock('require-only', () => ({ who: 'mock-require-only' }))
  return (require('require-only') as { who: string }).who
})

c('a factory for a package with only an import condition', () => {
  jest.doMock('import-only', () => ({ who: 'mock-import-only' }))
  return (require('import-only') as { who: string }).who
})
