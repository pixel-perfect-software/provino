function mockBump(): number {
  const g = globalThis as { factoryRuns?: number }
  g.factoryRuns = (g.factoryRuns ?? 0) + 1
  return g.factoryRuns
}

jest.mock('./mocked.ts', () => ({ kind: 'mock', run: mockBump() }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const factoryRuns = () => (globalThis as { factoryRuns?: number }).factoryRuns

c('a module read twice inside one isolation is one instance', () => {
  let first: { loads: number } | undefined
  let second: { loads: number } | undefined
  jest.isolateModules(() => {
    first = require('./counter.ts') as { loads: number }
    second = require('./counter.ts') as { loads: number }
  })
  return { same: first === second, loads: first?.loads }
})

c('two separate isolations give two instances', () => {
  let first: { loads: number } | undefined
  let second: { loads: number } | undefined
  jest.isolateModules(() => {
    first = require('./counter.ts') as { loads: number }
  })
  jest.isolateModules(() => {
    second = require('./counter.ts') as { loads: number }
  })
  return { same: first === second, firstLoads: first?.loads, secondLoads: second?.loads }
})

c('a factory mock read twice inside one isolation runs its factory once', () => {
  const before = factoryRuns()
  let first: unknown
  let second: unknown
  jest.isolateModules(() => {
    first = require('./mocked.ts')
    second = require('./mocked.ts')
  })
  return { same: first === second, ranHere: (factoryRuns() ?? 0) - (before ?? 0) }
})

c('the same mock read in two isolations runs its factory in each', () => {
  const before = factoryRuns()
  let first: unknown
  let second: unknown
  jest.isolateModules(() => {
    first = require('./mocked.ts')
  })
  jest.isolateModules(() => {
    second = require('./mocked.ts')
  })
  return { same: first === second, ranHere: (factoryRuns() ?? 0) - (before ?? 0) }
})
