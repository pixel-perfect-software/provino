import { kind as firstKind } from './mocked.ts'

function mockBump(): void {
  const g = globalThis as { factoryRuns?: number }
  g.factoryRuns = (g.factoryRuns ?? 0) + 1
}

vi.mock('./mocked.ts', () => {
  mockBump()
  return { kind: 'mock' }
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const runs = () => (globalThis as { factoryRuns?: number }).factoryRuns

c('a factory runs once for two imports of the module', async () => {
  const second = (await import('./mocked.ts')) as { kind: string }
  const third = (await import('./mocked.ts')) as { kind: string }
  return { runs: runs(), firstKind, secondKind: second.kind, thirdKind: third.kind }
})

c('every importer gets the same module object', async () => {
  const second = await import('./mocked.ts')
  const third = await import('./mocked.ts')
  return { same: second === third, runs: runs() }
})

c('requireActual is the real module, loaded once and cached', async () => {
  const first = await vi.importActual<{ kind: string }>('./real.ts')
  const second = await vi.importActual<{ kind: string }>('./real.ts')
  return {
    kind: first.kind,
    same: first === second,
    realLoads: (globalThis as { realLoads?: number }).realLoads,
  }
})

c('requireActual of a mocked module bypasses the factory and does not run it again', async () => {
  const actual = await vi.importActual<{ kind: string }>('./mocked.ts')
  const actualAgain = await vi.importActual<{ kind: string }>('./mocked.ts')
  return { kind: actual.kind, same: actual === actualAgain, runs: runs() }
})
