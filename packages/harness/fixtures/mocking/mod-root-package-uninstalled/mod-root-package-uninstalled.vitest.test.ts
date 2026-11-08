// Vitest's resolution errors name the absolute work directory, which a golden must not hold, and
// their wording is the loader's. Only the fact that the load failed is recorded.
const loadFailed = (): never => {
  throw new Error('the module could not be loaded')
}

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, async () => Promise.resolve(run()).catch(loadFailed)))
}

c('load with no mock call', async () => ((await import('ghost-pkg')) as { who: string }).who)

c('load after a bare doMock', async () => {
  vi.resetModules()
  vi.doMock('ghost-pkg')
  return ((await import('ghost-pkg')) as { who: string }).who
})

c('load after doMock with a factory', async () => {
  vi.resetModules()
  vi.doMock('ghost-pkg', () => ({ who: 'factory-ghost' }))
  return ((await import('ghost-pkg')) as { who: string }).who
})

c('load after doUnmock', async () => {
  vi.resetModules()
  vi.doUnmock('ghost-pkg')
  return ((await import('ghost-pkg')) as { who: string }).who
})
