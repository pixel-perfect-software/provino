const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('the sub-path with no mock call', async () => ((await import('pkg/sub')) as { who: string }).who)

c('the package root is not affected', async () => ((await import('pkg')) as { who: string }).who)

c('a bare doMock of the sub-path', async () => {
  vi.resetModules()
  vi.doMock('pkg/sub')
  return ((await import('pkg/sub')) as { who: string }).who
})

c('doUnmock of the sub-path brings back the real file', async () => {
  vi.resetModules()
  vi.doUnmock('pkg/sub')
  return ((await import('pkg/sub')) as { who: string }).who
})
