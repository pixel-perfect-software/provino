// A mock call written below the static imports. Vitest moves it above them.
import { name as aName } from './a.ts'
import { name as bName } from './b.ts'
import { name as cName } from './c.ts'

function mockBump(key: string): void {
  const g = globalThis as { runs?: Record<string, number> }
  g.runs ??= {}
  g.runs[key] = (g.runs[key] ?? 0) + 1
}
const runsAtLoad = { ...(globalThis as { runs?: Record<string, number> }).runs }

vi.mock('./a.ts', () => {
  mockBump('a')
  return { name: 'mock-a' }
})
vi.mock('./b.ts', () => {
  mockBump('b-first')
  return { name: 'mock-b-first' }
})
vi.mock('./b.ts', () => {
  mockBump('b-second')
  return { name: 'mock-b-second' }
})
vi.mock('./c.ts', () => {
  mockBump('c')
  return { name: 'mock-c' }
})
vi.mock('./lazy.ts', () => {
  mockBump('lazy')
  return { name: 'mock-lazy' }
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a mock call below the imports still applies to them', () => ({ aName }))

c('two calls for one module keep source order: the last one wins and the first never runs', () => ({
  bName,
  runs: { first: runsAtLoad['b-first'], second: runsAtLoad['b-second'] },
}))

c('a factory has run once when the file body starts, before the mock call line', () => ({
  atLoad: runsAtLoad,
  cName,
}))

c('a factory for a module nobody imported yet has not run until the first import', async () => {
  const g = globalThis as { runs?: Record<string, number> }
  const before = g.runs?.lazy
  const loaded = (await import('./lazy.ts')) as { name: string }
  const again = (await import('./lazy.ts')) as { name: string }
  return { before, after: g.runs?.lazy, name: loaded.name, same: loaded === again }
})
