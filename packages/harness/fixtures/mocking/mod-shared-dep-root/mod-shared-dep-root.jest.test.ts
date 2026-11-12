// No mock call: the root __mocks__/pkg-r.ts applies by name.
const c = (id: string, run: () => unknown) => {
  test(id, () => {
    jest.resetModules()
    return observe(id, run)
  })
}

c('the root-mocked package, required directly', () => (require('pkg-r') as { who: string }).who)

c('a package that requires the root-mocked one', () => (require('pkg-q') as { rWho: string }).rWho)

c(
  'a package with its own nested copy of the root-mocked one',
  () => (require('pkg-n') as { rWho: string }).rWho,
)
