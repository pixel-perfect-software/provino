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

c('resetModules with a factory mock: still mocked, factory runs again, new instance', async () => {
  const runs = () => (globalThis as { factoryRuns?: number }).factoryRuns
  const first = (await import('./mocked.ts')) as { kind: string }
  const runsBefore = runs()
  vi.resetModules()
  const second = (await import('./mocked.ts')) as { kind: string }
  return {
    firstKind: first.kind,
    secondKind: second.kind,
    runsBefore,
    runsAfter: runs(),
    sameInstance: first === second,
  }
})
