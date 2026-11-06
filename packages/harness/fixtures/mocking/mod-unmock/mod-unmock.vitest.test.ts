import { who as gone } from './gone.ts'

vi.mock('./gone.ts', () => ({ who: 'mock-gone' }))
vi.unmock('./gone.ts')
vi.mock('./later.ts', () => ({ who: 'mock-later' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('mock then unmock of one path leaves the real module', () => ({ gone }))

c('a non-hoisted unmock then resetModules loads the real module again', async () => {
  const mocked = (await import('./later.ts')) as { who: string }
  vi.doUnmock('./later.ts')
  vi.resetModules()
  const real = (await import('./later.ts')) as { who: string }
  return { mocked: mocked.who, real: real.who }
})
