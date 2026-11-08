const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('dontMock of a relative path that is not on disk', () => {
  jest.dontMock('./not-here.ts')
  return 'did not throw'
})

c('dontMock of a bare name that is not installed', () => {
  jest.dontMock('not-installed-pkg')
  return 'did not throw'
})

c('loading the unmocked missing relative path afterwards', () => {
  jest.dontMock('./not-here.ts')
  return require('./not-here.ts')
})

c('loading the unmocked missing bare name afterwards', () => {
  jest.dontMock('not-installed-pkg')
  return require('not-installed-pkg')
})
