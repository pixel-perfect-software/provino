jest.mock('./counted.ts')

const counts = (): Record<string, number> => ({
  ...(globalThis as { __counts?: Record<string, number> }).__counts,
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('the automock is built from a real load: the module and its dependency each ran once', () => {
  const mocked = require('./counted.ts') as { hello: () => unknown; tag: unknown }
  return { hello: mocked.hello(), tag: mocked.tag, counts: counts() }
})

c('a second require of the automock runs nothing', () => {
  require('./counted.ts')
  return counts()
})

c(
  'requireActual evaluates the module and its dependency again: the scratch load left nothing',
  () => {
    const actual = jest.requireActual('./counted.ts') as { hello: () => string; tag: string }
    return { hello: actual.hello(), tag: actual.tag, counts: counts() }
  },
)

c('the actual module is now in the registry: a second requireActual runs nothing', () => {
  jest.requireActual('./counted.ts')
  return counts()
})
