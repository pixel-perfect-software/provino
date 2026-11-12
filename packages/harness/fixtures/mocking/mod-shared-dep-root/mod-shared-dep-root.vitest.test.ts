vi.mock('pkg-r')

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

c('the root-mocked package, required directly', async () => read(await import('pkg-r'), 'who'))

c('a package that requires the root-mocked one', async () => read(await import('pkg-q'), 'rWho'))

c('a package with its own nested copy of the root-mocked one', async () =>
  read(await import('pkg-n'), 'rWho'),
)
