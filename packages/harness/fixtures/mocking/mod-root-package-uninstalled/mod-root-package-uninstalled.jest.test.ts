const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('load with no mock call', () => (require('ghost-pkg') as { who: string }).who)

c('load after a bare doMock', () => {
  jest.resetModules()
  jest.doMock('ghost-pkg')
  return (require('ghost-pkg') as { who: string }).who
})

c('load after doMock with a factory', () => {
  jest.resetModules()
  jest.doMock('ghost-pkg', () => ({ who: 'factory-ghost' }))
  return (require('ghost-pkg') as { who: string }).who
})

c('load after dontMock', () => {
  jest.resetModules()
  jest.dontMock('ghost-pkg')
  return (require('ghost-pkg') as { who: string }).who
})
