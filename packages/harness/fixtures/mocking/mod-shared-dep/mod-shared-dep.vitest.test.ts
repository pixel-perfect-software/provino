vi.mock('pkg-b', () => ({ who: 'mock-b' }))
vi.mock('os', () => ({ platform: () => 'mock-os', default: { platform: () => 'mock-os' } }))

const c = (id: string, run: () => unknown) => {
  test(id, () => {
    vi.resetModules()
    return observe(id, run)
  })
}

/** A property of a module that may be a CommonJS one: its namespace key, or `module.exports`'s. */
const read = (module: unknown, key: string): unknown => {
  const m = module as { default?: Record<string, unknown> } & Record<string, unknown>
  return key in m ? m[key] : m.default?.[key]
}

c('the mocked package itself, imported directly', async () => read(await import('pkg-b'), 'who'))

c('a package that requires the mocked one', async () => read(await import('pkg-a'), 'bWho'))

c('a package that requires a package that requires the mocked one', async () =>
  read(await import('pkg-c'), 'aSeesB'),
)

c('requireActual of a package: its view of the mocked one', async () =>
  read(await vi.importActual('pkg-a'), 'bWho'),
)

c('a package that requires a mocked builtin', async () => read(await import('pkg-os'), 'platform'))

c('a doMock after the importer loaded, then after resetModules', async () => {
  const before = read(await import('pkg-e'), 'dWho')
  vi.doMock('pkg-d', () => ({ who: 'mock-d' }))
  const afterMock = read(await import('pkg-e'), 'dWho')
  vi.resetModules()
  const afterReset = read(await import('pkg-e'), 'dWho')
  return { before, afterMock, afterReset }
})

c('a package with its own nested copy of the mocked one', async () =>
  read(await import('pkg-f'), 'bWho'),
)

c('an ES module package that imports the mocked one', async () =>
  read(await import('pkg-esm'), 'bWho'),
)
