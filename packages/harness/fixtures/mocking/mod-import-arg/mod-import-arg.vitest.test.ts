import { a, b } from './p.ts'

vi.mock(import('./p.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  a: 'mock-a',
}))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('vi.mock(import(path)) with a factory that spreads the original', () => ({ a, b }))
