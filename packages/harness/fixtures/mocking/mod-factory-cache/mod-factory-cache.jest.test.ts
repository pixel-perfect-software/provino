import { kind as firstKind } from './mocked.ts'

function mockBump(): void {
  const g = globalThis as { factoryRuns?: number }
  g.factoryRuns = (g.factoryRuns ?? 0) + 1
}

jest.mock('./mocked.ts', () => {
  mockBump()
  return { kind: 'mock' }
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const runs = () => (globalThis as { factoryRuns?: number }).factoryRuns

c('a factory runs once for two imports of the module', () => {
  const second = require('./mocked.ts') as { kind: string }
  const third = require('./mocked.ts') as { kind: string }
  return { runs: runs(), firstKind, secondKind: second.kind, thirdKind: third.kind }
})

c('every importer gets the same module object', () => {
  const second = require('./mocked.ts')
  const third = require('./mocked.ts')
  return { same: second === third, runs: runs() }
})

c('requireActual is the real module, loaded once and cached', () => {
  const first = jest.requireActual('./real.ts') as { kind: string }
  const second = jest.requireActual('./real.ts') as { kind: string }
  return {
    kind: first.kind,
    same: first === second,
    realLoads: (globalThis as { realLoads?: number }).realLoads,
  }
})

c('requireActual of a mocked module bypasses the factory and does not run it again', () => {
  const actual = jest.requireActual('./mocked.ts') as { kind: string }
  const actualAgain = jest.requireActual('./mocked.ts') as { kind: string }
  return { kind: actual.kind, same: actual === actualAgain, runs: runs() }
})
