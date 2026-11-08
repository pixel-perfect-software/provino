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

c('a real module loaded inside is loaded again outside', () => {
  let inner: { loads: number } | undefined
  jest.isolateModules(() => {
    inner = require('./counter.ts') as { loads: number }
  })
  const outer = require('./counter.ts') as { loads: number }
  const outerAgain = require('./counter.ts') as { loads: number }
  return {
    innerLoads: inner?.loads,
    outerLoads: outer.loads,
    same: inner === outer,
    outerCached: outer === outerAgain,
  }
})

c('a factory mock first read inside runs its factory again outside', () => {
  let inner: { run: number } | undefined
  jest.isolateModules(() => {
    inner = require('./mocked.ts') as { run: number }
  })
  const outer = require('./mocked.ts') as { run: number }
  return { same: inner === outer, innerRun: inner?.run, outerRun: outer.run, runs: factoryRuns() }
})

c('a doMock made inside an isolation applies outside after it', () => {
  jest.isolateModules(() => {
    jest.doMock('./later.ts', () => ({ kind: 'mock-later' }))
  })
  return { kind: (require('./later.ts') as { kind: string }).kind }
})
