jest.mock('pkg-b', () => ({ who: 'mock-b' }))
jest.mock('os', () => ({ platform: () => 'mock-os' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => {
    jest.resetModules()
    return observe(id, run)
  })
}

c('the mocked package itself, required directly', () => (require('pkg-b') as { who: string }).who)

c('a package that requires the mocked one', () => (require('pkg-a') as { bWho: string }).bWho)

c(
  'a package that requires a package that requires the mocked one',
  () => (require('pkg-c') as { aSeesB: string }).aSeesB,
)

c(
  'requireActual of a package: its view of the mocked one',
  () => (jest.requireActual('pkg-a') as { bWho: string }).bWho,
)

c(
  'a package that requires a mocked builtin',
  () => (require('pkg-os') as { platform: string }).platform,
)

c('a doMock after the importer loaded, then after resetModules', () => {
  const before = (require('pkg-e') as { dWho: string }).dWho
  jest.doMock('pkg-d', () => ({ who: 'mock-d' }))
  const afterMock = (require('pkg-e') as { dWho: string }).dWho
  jest.resetModules()
  const afterReset = (require('pkg-e') as { dWho: string }).dWho
  return { before, afterMock, afterReset }
})

c(
  'a package with its own nested copy of the mocked one',
  () => (require('pkg-f') as { bWho: string }).bWho,
)
