const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('the sub-path with no mock call', () => (require('pkg/sub') as { who: string }).who)

c('the package root is not affected', () => (require('pkg') as { who: string }).who)

c('a bare doMock of the sub-path', () => {
  jest.resetModules()
  jest.doMock('pkg/sub')
  return (require('pkg/sub') as { who: string }).who
})

c('dontMock of the sub-path brings back the real file', () => {
  jest.resetModules()
  jest.dontMock('pkg/sub')
  return (require('pkg/sub') as { who: string }).who
})
