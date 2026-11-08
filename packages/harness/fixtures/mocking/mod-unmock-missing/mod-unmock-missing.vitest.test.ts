const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

// Vitest's resolution errors name the absolute work directory, which a golden must not hold, and
// their wording is the loader's. Only the fact that the load failed is recorded.
const loadFailed = (): never => {
  throw new Error('the module could not be loaded')
}

c('dontMock of a relative path that is not on disk', () => {
  vi.doUnmock('./not-here.ts')
  return 'did not throw'
})

c('dontMock of a bare name that is not installed', () => {
  vi.doUnmock('not-installed-pkg')
  return 'did not throw'
})

c('loading the unmocked missing relative path afterwards', async () => {
  vi.doUnmock('./not-here.ts')
  return await import('./not-here.ts').catch(loadFailed)
})

c('loading the unmocked missing bare name afterwards', async () => {
  vi.doUnmock('not-installed-pkg')
  return await import('not-installed-pkg').catch(loadFailed)
})
